//! Durable asset admission, de-duplication, and document-scoped access control.
//!
//! This is the single-client SQLite implementation used to prove Phase 1 asset
//! semantics. Its BLOB-backed object store is intentionally replaceable: the
//! admission and authorization transaction boundary is independent of whether
//! bytes live in SQLite, S3, or another object store.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

pub type Id = [u8; 16];
pub type ContentHash = [u8; 32];

pub const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_DOWNLOAD_GRANT_LIFETIME_SECONDS: u64 = 15 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedPrincipal {
    pub tenant_id: Id,
    pub actor_id: Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    RasterImage,
    Font,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRequest {
    pub session_id: Id,
    pub kind: AssetKind,
    pub expected_content_hash: ContentHash,
    pub declared_media_type: String,
    pub expected_byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadSession {
    pub session_id: Id,
    pub accepted_byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRecord {
    pub asset_id: Id,
    pub tenant_id: Id,
    pub content_hash: ContentHash,
    pub kind: AssetKind,
    pub media_type: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedUpload {
    pub asset: AssetRecord,
    pub deduplicated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadGrant {
    pub asset_id: Id,
    pub document_id: Id,
    pub token: ContentHash,
    pub expires_at_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetServiceError {
    InvalidRequest,
    ResourceLimit,
    SessionMissing,
    UploadOffsetConflict { expected: usize, actual: usize },
    ContentHashMismatch,
    MimeMismatch,
    PermissionDenied,
    AssetMissing,
    GrantMissingOrExpired,
    Storage,
}

/// A durable, tenant-isolated resource service. Callers receive `TrustedPrincipal`
/// only after authentication; no tenant or actor value in upload metadata is used.
pub struct AssetService {
    connection: Mutex<Connection>,
}

impl AssetService {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AssetServiceError> {
        let connection = Connection::open(path).map_err(|_| AssetServiceError::Storage)?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> Result<Self, AssetServiceError> {
        let connection = Connection::open_in_memory().map_err(|_| AssetServiceError::Storage)?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, AssetServiceError> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS upload_sessions (
               session_id BLOB PRIMARY KEY NOT NULL CHECK(length(session_id) = 16),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               actor_id BLOB NOT NULL CHECK(length(actor_id) = 16),
               kind INTEGER NOT NULL,
               expected_hash BLOB NOT NULL CHECK(length(expected_hash) = 32),
               declared_media_type TEXT NOT NULL,
               expected_byte_length INTEGER NOT NULL,
               staged_bytes BLOB NOT NULL DEFAULT X''
             );
             CREATE TABLE IF NOT EXISTS assets (
               asset_id BLOB PRIMARY KEY NOT NULL CHECK(length(asset_id) = 16),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
               kind INTEGER NOT NULL,
               media_type TEXT NOT NULL,
               byte_length INTEGER NOT NULL,
               object_bytes BLOB NOT NULL,
               UNIQUE (tenant_id, content_hash)
             );
             CREATE TABLE IF NOT EXISTS document_readers (
               document_id BLOB NOT NULL CHECK(length(document_id) = 16),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               actor_id BLOB NOT NULL CHECK(length(actor_id) = 16),
               PRIMARY KEY (document_id, actor_id)
             );
             CREATE TABLE IF NOT EXISTS document_writers (
               document_id BLOB NOT NULL CHECK(length(document_id) = 16),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               actor_id BLOB NOT NULL CHECK(length(actor_id) = 16),
               PRIMARY KEY (document_id, actor_id)
             );
             CREATE TABLE IF NOT EXISTS document_assets (
               document_id BLOB NOT NULL CHECK(length(document_id) = 16),
               asset_id BLOB NOT NULL REFERENCES assets(asset_id) ON DELETE RESTRICT,
               PRIMARY KEY (document_id, asset_id)
             );
             CREATE TABLE IF NOT EXISTS download_grants (
               token BLOB PRIMARY KEY NOT NULL CHECK(length(token) = 32),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               document_id BLOB NOT NULL CHECK(length(document_id) = 16),
               asset_id BLOB NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
               expires_at_seconds INTEGER NOT NULL
             );",
            )
            .map_err(|_| AssetServiceError::Storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn begin_upload(
        &self,
        principal: TrustedPrincipal,
        request: UploadRequest,
    ) -> Result<UploadSession, AssetServiceError> {
        if request.expected_byte_length == 0
            || request.expected_byte_length > MAX_UPLOAD_BYTES
            || !is_media_type_allowed(request.kind, &request.declared_media_type)
        {
            return Err(AssetServiceError::InvalidRequest);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        connection.execute(
            "INSERT INTO upload_sessions (session_id, tenant_id, actor_id, kind, expected_hash, declared_media_type, expected_byte_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![request.session_id.as_slice(), principal.tenant_id.as_slice(), principal.actor_id.as_slice(), kind_to_db(request.kind), request.expected_content_hash.as_slice(), request.declared_media_type, request.expected_byte_length],
        ).map_err(|_| AssetServiceError::InvalidRequest)?;
        Ok(UploadSession {
            session_id: request.session_id,
            accepted_byte_length: 0,
        })
    }

    /// Appends exactly at the durable acknowledged offset. A caller may safely
    /// retry a failed request after querying `upload_progress`.
    pub fn append_chunk(
        &self,
        principal: TrustedPrincipal,
        session_id: Id,
        offset: usize,
        bytes: &[u8],
    ) -> Result<UploadSession, AssetServiceError> {
        if bytes.is_empty() {
            return Err(AssetServiceError::InvalidRequest);
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AssetServiceError::Storage)?;
        let session =
            load_session(&transaction, session_id)?.ok_or(AssetServiceError::SessionMissing)?;
        authorize_session(principal, &session)?;
        let expected_offset = session.staged_bytes.len();
        if offset != expected_offset {
            return Err(AssetServiceError::UploadOffsetConflict {
                expected: expected_offset,
                actual: offset,
            });
        }
        let next_length = expected_offset
            .checked_add(bytes.len())
            .ok_or(AssetServiceError::ResourceLimit)?;
        if next_length > session.expected_byte_length || next_length > MAX_UPLOAD_BYTES {
            return Err(AssetServiceError::ResourceLimit);
        }
        let mut combined = session.staged_bytes;
        combined.extend_from_slice(bytes);
        transaction
            .execute(
                "UPDATE upload_sessions SET staged_bytes = ?2 WHERE session_id = ?1",
                params![session_id.as_slice(), combined],
            )
            .map_err(|_| AssetServiceError::Storage)?;
        transaction
            .commit()
            .map_err(|_| AssetServiceError::Storage)?;
        Ok(UploadSession {
            session_id,
            accepted_byte_length: next_length,
        })
    }

    pub fn upload_progress(
        &self,
        principal: TrustedPrincipal,
        session_id: Id,
    ) -> Result<UploadSession, AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let session =
            load_session(&connection, session_id)?.ok_or(AssetServiceError::SessionMissing)?;
        authorize_session(principal, &session)?;
        Ok(UploadSession {
            session_id,
            accepted_byte_length: session.staged_bytes.len(),
        })
    }

    pub fn complete_upload(
        &self,
        principal: TrustedPrincipal,
        session_id: Id,
    ) -> Result<CompletedUpload, AssetServiceError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AssetServiceError::Storage)?;
        let session =
            load_session(&transaction, session_id)?.ok_or(AssetServiceError::SessionMissing)?;
        authorize_session(principal, &session)?;
        if session.staged_bytes.len() != session.expected_byte_length {
            return Err(AssetServiceError::InvalidRequest);
        }
        let actual_hash: ContentHash = Sha256::digest(&session.staged_bytes).into();
        if actual_hash != session.expected_hash {
            return Err(AssetServiceError::ContentHashMismatch);
        }
        let detected_media_type = detect_media_type(session.kind, &session.staged_bytes)
            .ok_or(AssetServiceError::MimeMismatch)?;
        if detected_media_type != session.declared_media_type {
            return Err(AssetServiceError::MimeMismatch);
        }
        if let Some(asset) = load_asset_by_hash(&transaction, principal.tenant_id, actual_hash)? {
            transaction
                .execute(
                    "DELETE FROM upload_sessions WHERE session_id = ?1",
                    params![session_id.as_slice()],
                )
                .map_err(|_| AssetServiceError::Storage)?;
            transaction
                .commit()
                .map_err(|_| AssetServiceError::Storage)?;
            return Ok(CompletedUpload {
                asset,
                deduplicated: true,
            });
        }
        let asset_id = derived_asset_id(principal.tenant_id, actual_hash);
        let asset = AssetRecord {
            asset_id,
            tenant_id: principal.tenant_id,
            content_hash: actual_hash,
            kind: session.kind,
            media_type: detected_media_type.to_owned(),
            byte_length: session.staged_bytes.len(),
        };
        transaction.execute(
            "INSERT INTO assets (asset_id, tenant_id, content_hash, kind, media_type, byte_length, object_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![asset.asset_id.as_slice(), asset.tenant_id.as_slice(), asset.content_hash.as_slice(), kind_to_db(asset.kind), asset.media_type, asset.byte_length, session.staged_bytes],
        ).map_err(|_| AssetServiceError::Storage)?;
        transaction
            .execute(
                "DELETE FROM upload_sessions WHERE session_id = ?1",
                params![session_id.as_slice()],
            )
            .map_err(|_| AssetServiceError::Storage)?;
        transaction
            .commit()
            .map_err(|_| AssetServiceError::Storage)?;
        Ok(CompletedUpload {
            asset,
            deduplicated: false,
        })
    }

    /// Adds the trusted document ACL used by this small standalone service. A
    /// production gateway derives the same membership from the document service.
    pub fn grant_document_reader(
        &self,
        tenant_id: Id,
        document_id: Id,
        actor_id: Id,
    ) -> Result<(), AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        connection.execute("INSERT OR IGNORE INTO document_readers (document_id, tenant_id, actor_id) VALUES (?1, ?2, ?3)", params![document_id.as_slice(), tenant_id.as_slice(), actor_id.as_slice()]).map_err(|_| AssetServiceError::Storage)?;
        Ok(())
    }

    /// A writer is also a reader, but only a writer can introduce an AssetId into
    /// a document. This mirrors the Document Service's object-level edit policy.
    pub fn grant_document_writer(
        &self,
        tenant_id: Id,
        document_id: Id,
        actor_id: Id,
    ) -> Result<(), AssetServiceError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AssetServiceError::Storage)?;
        transaction.execute("INSERT OR IGNORE INTO document_readers (document_id, tenant_id, actor_id) VALUES (?1, ?2, ?3)", params![document_id.as_slice(), tenant_id.as_slice(), actor_id.as_slice()]).map_err(|_| AssetServiceError::Storage)?;
        transaction.execute("INSERT OR IGNORE INTO document_writers (document_id, tenant_id, actor_id) VALUES (?1, ?2, ?3)", params![document_id.as_slice(), tenant_id.as_slice(), actor_id.as_slice()]).map_err(|_| AssetServiceError::Storage)?;
        transaction.commit().map_err(|_| AssetServiceError::Storage)
    }

    pub fn attach_asset_to_document(
        &self,
        principal: TrustedPrincipal,
        document_id: Id,
        asset_id: Id,
    ) -> Result<(), AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        if !can_write_document(&connection, principal, document_id)? {
            return Err(AssetServiceError::PermissionDenied);
        }
        let asset = load_asset(&connection, asset_id)?.ok_or(AssetServiceError::AssetMissing)?;
        if asset.tenant_id != principal.tenant_id {
            return Err(AssetServiceError::PermissionDenied);
        }
        connection
            .execute(
                "INSERT OR IGNORE INTO document_assets (document_id, asset_id) VALUES (?1, ?2)",
                params![document_id.as_slice(), asset_id.as_slice()],
            )
            .map_err(|_| AssetServiceError::Storage)?;
        Ok(())
    }

    /// Issues a random, short-lived token that an HTTP adapter can place in a
    /// download URL. Both the token and the document membership are rechecked on
    /// use; possessing an AssetId alone is never sufficient for download.
    pub fn issue_download_grant(
        &self,
        principal: TrustedPrincipal,
        document_id: Id,
        asset_id: Id,
        now_seconds: u64,
        lifetime_seconds: u64,
    ) -> Result<DownloadGrant, AssetServiceError> {
        if lifetime_seconds == 0 || lifetime_seconds > MAX_DOWNLOAD_GRANT_LIFETIME_SECONDS {
            return Err(AssetServiceError::InvalidRequest);
        }
        let expires_at_seconds = now_seconds
            .checked_add(lifetime_seconds)
            .ok_or(AssetServiceError::InvalidRequest)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        if !can_read_document(&connection, principal, document_id)?
            || !document_has_asset(&connection, document_id, asset_id)?
        {
            return Err(AssetServiceError::PermissionDenied);
        }
        let asset = load_asset(&connection, asset_id)?.ok_or(AssetServiceError::AssetMissing)?;
        if asset.tenant_id != principal.tenant_id {
            return Err(AssetServiceError::PermissionDenied);
        }
        for _ in 0..4 {
            let mut token = [0; 32];
            getrandom::getrandom(&mut token).map_err(|_| AssetServiceError::Storage)?;
            let result = connection.execute("INSERT INTO download_grants (token, tenant_id, document_id, asset_id, expires_at_seconds) VALUES (?1, ?2, ?3, ?4, ?5)", params![token.as_slice(), principal.tenant_id.as_slice(), document_id.as_slice(), asset_id.as_slice(), expires_at_seconds]);
            match result {
                Ok(_) => {
                    return Ok(DownloadGrant {
                        asset_id,
                        document_id,
                        token,
                        expires_at_seconds,
                    });
                }
                Err(rusqlite::Error::SqliteFailure(_, _)) => continue,
                Err(_) => return Err(AssetServiceError::Storage),
            }
        }
        Err(AssetServiceError::Storage)
    }

    pub fn download_with_grant(
        &self,
        principal: TrustedPrincipal,
        grant: &DownloadGrant,
        now_seconds: u64,
    ) -> Result<(AssetRecord, Vec<u8>), AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let stored = connection.query_row(
            "SELECT tenant_id, document_id, asset_id, expires_at_seconds FROM download_grants WHERE token = ?1",
            params![grant.token.as_slice()],
            |row| Ok((id_from_vec(row.get(0)?)?, id_from_vec(row.get(1)?)?, id_from_vec(row.get(2)?)?, row.get::<_, u64>(3)?)),
        ).optional().map_err(|_| AssetServiceError::Storage)?.ok_or(AssetServiceError::GrantMissingOrExpired)?;
        if stored.0 != principal.tenant_id
            || stored.1 != grant.document_id
            || stored.2 != grant.asset_id
            || stored.3 != grant.expires_at_seconds
            || now_seconds > stored.3
            || !can_read_document(&connection, principal, stored.1)?
            || !document_has_asset(&connection, stored.1, stored.2)?
        {
            return Err(AssetServiceError::GrantMissingOrExpired);
        }
        load_asset_bytes(&connection, stored.2)?.ok_or(AssetServiceError::AssetMissing)
    }

    /// Resolves the complete durable grant tuple from its random token before
    /// applying the same tenant, reader, expiry and attachment checks as the
    /// explicit-grant API. HTTP download endpoints expose only the token, never
    /// a caller-controlled document or asset identifier.
    pub fn download_with_token(
        &self,
        principal: TrustedPrincipal,
        token: ContentHash,
        now_seconds: u64,
    ) -> Result<(AssetRecord, Vec<u8>), AssetServiceError> {
        let grant = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| AssetServiceError::Storage)?;
            connection
                .query_row(
                    "SELECT document_id, asset_id, expires_at_seconds FROM download_grants WHERE token = ?1",
                    params![token.as_slice()],
                    |row| Ok(DownloadGrant {
                        document_id: id_from_vec(row.get(0)?)?,
                        asset_id: id_from_vec(row.get(1)?)?,
                        token,
                        expires_at_seconds: row.get(2)?,
                    }),
                )
                .optional()
                .map_err(|_| AssetServiceError::Storage)?
                .ok_or(AssetServiceError::GrantMissingOrExpired)?
        };
        self.download_with_grant(principal, &grant, now_seconds)
    }
}

#[derive(Debug)]
struct StoredSession {
    tenant_id: Id,
    actor_id: Id,
    kind: AssetKind,
    expected_hash: ContentHash,
    declared_media_type: String,
    expected_byte_length: usize,
    staged_bytes: Vec<u8>,
}

fn load_session(
    connection: &Connection,
    session_id: Id,
) -> Result<Option<StoredSession>, AssetServiceError> {
    connection.query_row(
        "SELECT tenant_id, actor_id, kind, expected_hash, declared_media_type, expected_byte_length, staged_bytes FROM upload_sessions WHERE session_id = ?1",
        params![session_id.as_slice()],
        |row| Ok(StoredSession { tenant_id: id_from_vec(row.get(0)?)?, actor_id: id_from_vec(row.get(1)?)?, kind: kind_from_db(row.get(2)?)?, expected_hash: hash_from_vec(row.get(3)?)?, declared_media_type: row.get(4)?, expected_byte_length: row.get(5)?, staged_bytes: row.get(6)? }),
    ).optional().map_err(|_| AssetServiceError::Storage)
}

fn load_asset(
    connection: &Connection,
    asset_id: Id,
) -> Result<Option<AssetRecord>, AssetServiceError> {
    connection.query_row("SELECT tenant_id, content_hash, kind, media_type, byte_length FROM assets WHERE asset_id = ?1", params![asset_id.as_slice()], |row| Ok(AssetRecord { asset_id, tenant_id: id_from_vec(row.get(0)?)?, content_hash: hash_from_vec(row.get(1)?)?, kind: kind_from_db(row.get(2)?)?, media_type: row.get(3)?, byte_length: row.get(4)? })).optional().map_err(|_| AssetServiceError::Storage)
}

fn load_asset_by_hash(
    connection: &Connection,
    tenant_id: Id,
    content_hash: ContentHash,
) -> Result<Option<AssetRecord>, AssetServiceError> {
    connection.query_row("SELECT asset_id, kind, media_type, byte_length FROM assets WHERE tenant_id = ?1 AND content_hash = ?2", params![tenant_id.as_slice(), content_hash.as_slice()], |row| Ok(AssetRecord { asset_id: id_from_vec(row.get(0)?)?, tenant_id, content_hash, kind: kind_from_db(row.get(1)?)?, media_type: row.get(2)?, byte_length: row.get(3)? })).optional().map_err(|_| AssetServiceError::Storage)
}

fn load_asset_bytes(
    connection: &Connection,
    asset_id: Id,
) -> Result<Option<(AssetRecord, Vec<u8>)>, AssetServiceError> {
    connection.query_row("SELECT tenant_id, content_hash, kind, media_type, byte_length, object_bytes FROM assets WHERE asset_id = ?1", params![asset_id.as_slice()], |row| Ok((AssetRecord { asset_id, tenant_id: id_from_vec(row.get(0)?)?, content_hash: hash_from_vec(row.get(1)?)?, kind: kind_from_db(row.get(2)?)?, media_type: row.get(3)?, byte_length: row.get(4)? }, row.get(5)?))).optional().map_err(|_| AssetServiceError::Storage)
}

fn authorize_session(
    principal: TrustedPrincipal,
    session: &StoredSession,
) -> Result<(), AssetServiceError> {
    if principal.tenant_id == session.tenant_id && principal.actor_id == session.actor_id {
        Ok(())
    } else {
        Err(AssetServiceError::PermissionDenied)
    }
}
fn can_read_document(
    connection: &Connection,
    principal: TrustedPrincipal,
    document_id: Id,
) -> Result<bool, AssetServiceError> {
    connection.query_row("SELECT 1 FROM document_readers WHERE document_id = ?1 AND tenant_id = ?2 AND actor_id = ?3", params![document_id.as_slice(), principal.tenant_id.as_slice(), principal.actor_id.as_slice()], |_| Ok(())).optional().map_err(|_| AssetServiceError::Storage).map(|row| row.is_some())
}
fn can_write_document(
    connection: &Connection,
    principal: TrustedPrincipal,
    document_id: Id,
) -> Result<bool, AssetServiceError> {
    connection.query_row("SELECT 1 FROM document_writers WHERE document_id = ?1 AND tenant_id = ?2 AND actor_id = ?3", params![document_id.as_slice(), principal.tenant_id.as_slice(), principal.actor_id.as_slice()], |_| Ok(())).optional().map_err(|_| AssetServiceError::Storage).map(|row| row.is_some())
}
fn document_has_asset(
    connection: &Connection,
    document_id: Id,
    asset_id: Id,
) -> Result<bool, AssetServiceError> {
    connection
        .query_row(
            "SELECT 1 FROM document_assets WHERE document_id = ?1 AND asset_id = ?2",
            params![document_id.as_slice(), asset_id.as_slice()],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| AssetServiceError::Storage)
        .map(|row| row.is_some())
}
fn id_from_vec(value: Vec<u8>) -> Result<Id, rusqlite::Error> {
    value.try_into().map_err(|_| rusqlite::Error::InvalidQuery)
}
fn hash_from_vec(value: Vec<u8>) -> Result<ContentHash, rusqlite::Error> {
    value.try_into().map_err(|_| rusqlite::Error::InvalidQuery)
}
fn kind_to_db(kind: AssetKind) -> i64 {
    match kind {
        AssetKind::RasterImage => 1,
        AssetKind::Font => 2,
    }
}
fn kind_from_db(value: i64) -> Result<AssetKind, rusqlite::Error> {
    match value {
        1 => Ok(AssetKind::RasterImage),
        2 => Ok(AssetKind::Font),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn is_media_type_allowed(kind: AssetKind, media_type: &str) -> bool {
    matches!(
        (kind, media_type),
        (
            AssetKind::RasterImage,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) | (
            AssetKind::Font,
            "font/woff2" | "font/woff" | "font/ttf" | "font/otf"
        )
    )
}
fn detect_media_type(kind: AssetKind, bytes: &[u8]) -> Option<&'static str> {
    match kind {
        AssetKind::RasterImage if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image/png"),
        AssetKind::RasterImage if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image/jpeg"),
        AssetKind::RasterImage if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            Some("image/gif")
        }
        AssetKind::RasterImage
            if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") =>
        {
            Some("image/webp")
        }
        AssetKind::Font if bytes.starts_with(b"wOF2") => Some("font/woff2"),
        AssetKind::Font if bytes.starts_with(b"wOFF") => Some("font/woff"),
        AssetKind::Font if bytes.starts_with(&[0, 1, 0, 0]) => Some("font/ttf"),
        AssetKind::Font if bytes.starts_with(b"OTTO") => Some("font/otf"),
        _ => None,
    }
}
fn derived_asset_id(tenant_id: Id, content_hash: ContentHash) -> Id {
    let digest = Sha256::digest(
        [
            b"makefigma/asset-id/v1".as_slice(),
            tenant_id.as_slice(),
            content_hash.as_slice(),
        ]
        .concat(),
    );
    digest[..16].try_into().expect("sha256 has 32 bytes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u8) -> Id {
        [value; 16]
    }
    fn principal(actor: u8) -> TrustedPrincipal {
        TrustedPrincipal {
            tenant_id: id(2),
            actor_id: id(actor),
        }
    }
    fn png() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\nverified-payload".to_vec()
    }
    fn request(session: u8, bytes: &[u8]) -> UploadRequest {
        UploadRequest {
            session_id: id(session),
            kind: AssetKind::RasterImage,
            expected_content_hash: Sha256::digest(bytes).into(),
            declared_media_type: "image/png".into(),
            expected_byte_length: bytes.len(),
        }
    }

    #[test]
    fn resumable_upload_is_content_verified_and_deduplicated() {
        let service = AssetService::in_memory().unwrap();
        let bytes = png();
        service
            .begin_upload(principal(7), request(10, &bytes))
            .unwrap();
        assert_eq!(
            service
                .append_chunk(principal(7), id(10), 0, &bytes[..8])
                .unwrap()
                .accepted_byte_length,
            8
        );
        assert_eq!(
            service.append_chunk(principal(7), id(10), 0, &bytes[8..]),
            Err(AssetServiceError::UploadOffsetConflict {
                expected: 8,
                actual: 0
            })
        );
        service
            .append_chunk(principal(7), id(10), 8, &bytes[8..])
            .unwrap();
        let first = service.complete_upload(principal(7), id(10)).unwrap();
        assert!(!first.deduplicated);
        service
            .begin_upload(principal(7), request(11, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(11), 0, &bytes)
            .unwrap();
        let second = service.complete_upload(principal(7), id(11)).unwrap();
        assert!(second.deduplicated);
        assert_eq!(first.asset.asset_id, second.asset.asset_id);
    }

    #[test]
    fn asset_download_requires_document_membership_and_a_live_grant() {
        let service = AssetService::in_memory().unwrap();
        let bytes = png();
        service
            .begin_upload(principal(7), request(10, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(10), 0, &bytes)
            .unwrap();
        let asset = service.complete_upload(principal(7), id(10)).unwrap().asset;
        let document = id(3);
        service
            .grant_document_writer(id(2), document, id(7))
            .unwrap();
        service
            .attach_asset_to_document(principal(7), document, asset.asset_id)
            .unwrap();
        assert_eq!(
            service.issue_download_grant(principal(8), document, asset.asset_id, 100, 10),
            Err(AssetServiceError::PermissionDenied)
        );
        let grant = service
            .issue_download_grant(principal(7), document, asset.asset_id, 100, 10)
            .unwrap();
        assert_eq!(
            service.download_with_grant(principal(8), &grant, 105),
            Err(AssetServiceError::GrantMissingOrExpired)
        );
        assert_eq!(
            service
                .download_with_grant(principal(7), &grant, 105)
                .unwrap()
                .1,
            bytes
        );
        assert_eq!(
            service.download_with_grant(principal(7), &grant, 111),
            Err(AssetServiceError::GrantMissingOrExpired)
        );
    }

    #[test]
    fn corrupt_or_spoofed_uploads_never_become_assets() {
        let service = AssetService::in_memory().unwrap();
        let bytes = png();
        let mut wrong_hash_request = request(10, &bytes);
        wrong_hash_request.expected_content_hash = [0; 32];
        service
            .begin_upload(principal(7), wrong_hash_request)
            .unwrap();
        service
            .append_chunk(principal(7), id(10), 0, &bytes)
            .unwrap();
        assert_eq!(
            service.complete_upload(principal(7), id(10)),
            Err(AssetServiceError::ContentHashMismatch)
        );
        assert_eq!(
            service.upload_progress(principal(8), id(10)),
            Err(AssetServiceError::PermissionDenied)
        );
        let mut mismatched_mime = request(11, &bytes);
        mismatched_mime.declared_media_type = "image/jpeg".into();
        service.begin_upload(principal(7), mismatched_mime).unwrap();
        service
            .append_chunk(principal(7), id(11), 0, &bytes)
            .unwrap();
        assert_eq!(
            service.complete_upload(principal(7), id(11)),
            Err(AssetServiceError::MimeMismatch)
        );
    }
}
