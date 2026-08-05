//! Durable asset admission, de-duplication, and document-scoped access control.
//!
//! This is the single-client SQLite implementation used to prove Phase 1 asset
//! semantics. Its BLOB-backed object store is intentionally replaceable: the
//! admission and authorization transaction boundary is independent of whether
//! bytes live in SQLite, S3, or another object store.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

pub type Id = [u8; 16];
pub type ContentHash = [u8; 32];

pub const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_DOWNLOAD_GRANT_LIFETIME_SECONDS: u64 = 15 * 60;
pub const MAX_AUDIT_EVENT_PAGE_SIZE: usize = 500;

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

/// Durable, intentionally metadata-only audit record. It excludes filenames,
/// source URLs, object bytes, session tokens and caller-supplied identities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetAuditEvent {
    pub sequence: i64,
    pub tenant_id: Id,
    pub document_id: Option<Id>,
    pub asset_id: Option<Id>,
    pub action: String,
    pub outcome: String,
    pub at_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AssetCleanupReport {
    pub expired_grants: usize,
    pub abandoned_uploads: usize,
    pub queued_orphaned_objects: usize,
    pub deleted_orphaned_objects: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetServiceError {
    InvalidRequest,
    ResourceLimit,
    SessionMissing,
    UploadOffsetConflict { expected: usize, actual: usize },
    ContentHashMismatch,
    MimeMismatch,
    FontInvalid,
    PermissionDenied,
    AssetMissing,
    GrantMissingOrExpired,
    Storage,
}

/// A content-addressed object store intentionally separate from the SQLite
/// metadata, ACL and upload-state database. A store write must succeed before
/// an AssetRecord can become visible to callers.
pub trait AssetObjectStore: Send + Sync {
    fn put(&self, key: AssetObjectKey, bytes: &[u8]) -> Result<(), AssetServiceError>;
    fn get(&self, key: AssetObjectKey) -> Result<Option<Vec<u8>>, AssetServiceError>;
    fn delete(&self, key: AssetObjectKey) -> Result<(), AssetServiceError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AssetObjectKey {
    pub tenant_id: Id,
    pub content_hash: ContentHash,
}

/// The durable Phase 1 adapter. Object names are derived from tenant and
/// content hash, while temporary writes are fsync'd before the atomic rename.
pub struct LocalFileObjectStore {
    root: PathBuf,
    next_temp_id: AtomicU64,
    fail_next_write: AtomicBool,
}

impl LocalFileObjectStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, AssetServiceError> {
        fs::create_dir_all(root.as_ref()).map_err(|_| AssetServiceError::Storage)?;
        Ok(Self {
            root: root.as_ref().to_path_buf(),
            next_temp_id: AtomicU64::new(0),
            fail_next_write: AtomicBool::new(false),
        })
    }

    /// Allows a deterministic failure-injection test of the commit boundary.
    pub fn fail_next_write(&self) {
        self.fail_next_write.store(true, Ordering::Release);
    }

    fn path_for(&self, key: AssetObjectKey) -> PathBuf {
        self.root
            .join(hex(&key.tenant_id))
            .join(hex(&key.content_hash))
    }
}

impl AssetObjectStore for LocalFileObjectStore {
    fn put(&self, key: AssetObjectKey, bytes: &[u8]) -> Result<(), AssetServiceError> {
        if self.fail_next_write.swap(false, Ordering::AcqRel) {
            return Err(AssetServiceError::Storage);
        }
        let destination = self.path_for(key);
        let parent = destination.parent().ok_or(AssetServiceError::Storage)?;
        fs::create_dir_all(parent).map_err(|_| AssetServiceError::Storage)?;
        if destination.exists() {
            return if fs::read(destination).map_err(|_| AssetServiceError::Storage)? == bytes {
                Ok(())
            } else {
                Err(AssetServiceError::Storage)
            };
        }
        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            hex(&key.content_hash),
            self.next_temp_id.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| AssetServiceError::Storage)?;
        if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(AssetServiceError::Storage);
        }
        fs::rename(&temporary, &destination).map_err(|_| {
            let _ = fs::remove_file(&temporary);
            AssetServiceError::Storage
        })
    }

    fn get(&self, key: AssetObjectKey) -> Result<Option<Vec<u8>>, AssetServiceError> {
        match fs::read(self.path_for(key)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(AssetServiceError::Storage),
        }
    }

    fn delete(&self, key: AssetObjectKey) -> Result<(), AssetServiceError> {
        match fs::remove_file(self.path_for(key)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(AssetServiceError::Storage),
        }
    }
}

struct InMemoryObjectStore(Mutex<HashMap<AssetObjectKey, Vec<u8>>>);

impl AssetObjectStore for InMemoryObjectStore {
    fn put(&self, key: AssetObjectKey, bytes: &[u8]) -> Result<(), AssetServiceError> {
        let mut objects = self.0.lock().map_err(|_| AssetServiceError::Storage)?;
        match objects.get(&key) {
            Some(existing) if existing != bytes => Err(AssetServiceError::Storage),
            Some(_) => Ok(()),
            None => {
                objects.insert(key, bytes.to_vec());
                Ok(())
            }
        }
    }
    fn get(&self, key: AssetObjectKey) -> Result<Option<Vec<u8>>, AssetServiceError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| AssetServiceError::Storage)?
            .get(&key)
            .cloned())
    }
    fn delete(&self, key: AssetObjectKey) -> Result<(), AssetServiceError> {
        self.0
            .lock()
            .map_err(|_| AssetServiceError::Storage)?
            .remove(&key);
        Ok(())
    }
}

/// A durable, tenant-isolated resource service. Callers receive `TrustedPrincipal`
/// only after authentication; no tenant or actor value in upload metadata is used.
pub struct AssetService {
    connection: Mutex<Connection>,
    object_store: Arc<dyn AssetObjectStore>,
    /// Existing developer databases had a non-null BLOB column. Migration
    /// empties it, but inserts retain an empty compatibility value until the
    /// database can be compacted in a later maintenance release.
    legacy_asset_blob_column: bool,
}

impl AssetService {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AssetServiceError> {
        let path = path.as_ref();
        let root = path.with_extension("objects");
        Self::open_with_store(path, Arc::new(LocalFileObjectStore::open(root)?))
    }

    pub fn open_with_store(
        path: impl AsRef<Path>,
        object_store: Arc<dyn AssetObjectStore>,
    ) -> Result<Self, AssetServiceError> {
        let connection = Connection::open(path).map_err(|_| AssetServiceError::Storage)?;
        Self::from_connection(connection, object_store)
    }

    pub fn in_memory() -> Result<Self, AssetServiceError> {
        let connection = Connection::open_in_memory().map_err(|_| AssetServiceError::Storage)?;
        Self::from_connection(
            connection,
            Arc::new(InMemoryObjectStore(Mutex::new(HashMap::new()))),
        )
    }

    fn from_connection(
        connection: Connection,
        object_store: Arc<dyn AssetObjectStore>,
    ) -> Result<Self, AssetServiceError> {
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
               created_at_seconds INTEGER NOT NULL,
               staged_bytes BLOB NOT NULL DEFAULT X''
             );
             CREATE TABLE IF NOT EXISTS assets (
               asset_id BLOB PRIMARY KEY NOT NULL CHECK(length(asset_id) = 16),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
               kind INTEGER NOT NULL,
               media_type TEXT NOT NULL,
               byte_length INTEGER NOT NULL,
               object_key TEXT NOT NULL,
               created_at_seconds INTEGER NOT NULL,
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
             );
             CREATE TABLE IF NOT EXISTS asset_audit_events (
               sequence INTEGER PRIMARY KEY AUTOINCREMENT,
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               document_id BLOB CHECK(document_id IS NULL OR length(document_id) = 16),
               asset_id BLOB CHECK(asset_id IS NULL OR length(asset_id) = 16),
               action TEXT NOT NULL,
               outcome TEXT NOT NULL,
               at_seconds INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS object_cleanup_queue (
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
               PRIMARY KEY (tenant_id, content_hash)
             );",
            )
            .map_err(|_| AssetServiceError::Storage)?;
        let legacy_asset_blob_column =
            migrate_legacy_asset_blobs(&connection, object_store.as_ref())?;
        migrate_maintenance_columns(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            object_store,
            legacy_asset_blob_column,
        })
    }

    pub fn begin_upload(
        &self,
        principal: TrustedPrincipal,
        request: UploadRequest,
    ) -> Result<UploadSession, AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        if request.expected_byte_length == 0
            || request.expected_byte_length > MAX_UPLOAD_BYTES
            || !is_media_type_allowed(request.kind, &request.declared_media_type)
        {
            record_upload_rejection(&connection, principal.tenant_id, "invalid_request")?;
            return Err(AssetServiceError::InvalidRequest);
        }
        connection.execute(
            "INSERT INTO upload_sessions (session_id, tenant_id, actor_id, kind, expected_hash, declared_media_type, expected_byte_length, created_at_seconds) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![request.session_id.as_slice(), principal.tenant_id.as_slice(), principal.actor_id.as_slice(), kind_to_db(request.kind), request.expected_content_hash.as_slice(), request.declared_media_type, request.expected_byte_length, current_time_seconds()],
        ).map_err(|_| AssetServiceError::InvalidRequest)?;
        record_asset_audit(
            &connection,
            principal.tenant_id,
            None,
            None,
            "upload_started",
            "accepted",
        )?;
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
        let session = match load_session(&transaction, session_id)? {
            Some(session) => session,
            None => {
                drop(transaction);
                record_upload_rejection(&connection, principal.tenant_id, "session_missing")?;
                return Err(AssetServiceError::SessionMissing);
            }
        };
        if let Err(error) = authorize_session(principal, &session) {
            drop(transaction);
            record_upload_rejection(&connection, principal.tenant_id, "permission_denied")?;
            return Err(error);
        }
        if session.staged_bytes.len() != session.expected_byte_length {
            drop(transaction);
            record_upload_rejection(&connection, principal.tenant_id, "incomplete_upload")?;
            return Err(AssetServiceError::InvalidRequest);
        }
        let actual_hash: ContentHash = Sha256::digest(&session.staged_bytes).into();
        if actual_hash != session.expected_hash {
            drop(transaction);
            record_upload_rejection(&connection, principal.tenant_id, "content_hash_mismatch")?;
            return Err(AssetServiceError::ContentHashMismatch);
        }
        let detected_media_type = match detect_media_type(session.kind, &session.staged_bytes) {
            Some(media_type) => media_type,
            None => {
                drop(transaction);
                record_upload_rejection(&connection, principal.tenant_id, "mime_mismatch")?;
                return Err(AssetServiceError::MimeMismatch);
            }
        };
        if detected_media_type != session.declared_media_type {
            drop(transaction);
            record_upload_rejection(&connection, principal.tenant_id, "mime_mismatch")?;
            return Err(AssetServiceError::MimeMismatch);
        }
        if session.kind == AssetKind::Font && !valid_font(&session.staged_bytes) {
            drop(transaction);
            record_upload_rejection(&connection, principal.tenant_id, "font_invalid")?;
            return Err(AssetServiceError::FontInvalid);
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
            record_asset_audit(
                &connection,
                principal.tenant_id,
                None,
                Some(asset.asset_id),
                "upload_completed",
                "deduplicated",
            )?;
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
        let object_key = AssetObjectKey {
            tenant_id: asset.tenant_id,
            content_hash: asset.content_hash,
        };
        self.object_store.put(object_key, &session.staged_bytes)?;
        let insert = if self.legacy_asset_blob_column {
            transaction.execute(
                "INSERT INTO assets (asset_id, tenant_id, content_hash, kind, media_type, byte_length, object_key, created_at_seconds, object_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, X'')",
                params![asset.asset_id.as_slice(), asset.tenant_id.as_slice(), asset.content_hash.as_slice(), kind_to_db(asset.kind), asset.media_type, asset.byte_length, object_key_string(object_key), current_time_seconds()],
            )
        } else {
            transaction.execute(
                "INSERT INTO assets (asset_id, tenant_id, content_hash, kind, media_type, byte_length, object_key, created_at_seconds) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![asset.asset_id.as_slice(), asset.tenant_id.as_slice(), asset.content_hash.as_slice(), kind_to_db(asset.kind), asset.media_type, asset.byte_length, object_key_string(object_key), current_time_seconds()],
            )
        };
        if insert.is_err() {
            // No AssetRecord can reference this key yet. Compensate before
            // returning so a metadata failure cannot turn a verified upload
            // into an untracked object-store orphan.
            drop(transaction);
            let _ = self.object_store.delete(object_key);
            return Err(AssetServiceError::Storage);
        }
        if transaction
            .execute(
                "DELETE FROM upload_sessions WHERE session_id = ?1",
                params![session_id.as_slice()],
            )
            .is_err()
        {
            drop(transaction);
            let _ = self.object_store.delete(object_key);
            return Err(AssetServiceError::Storage);
        }
        if transaction.commit().is_err() {
            // Commit has failed, so SQLite has rolled back the AssetRecord.
            // The object may safely be removed and a retry can reuse the
            // durable upload session without leaving a dangling object.
            let _ = self.object_store.delete(object_key);
            return Err(AssetServiceError::Storage);
        }
        record_asset_audit(
            &connection,
            principal.tenant_id,
            None,
            Some(asset.asset_id),
            "upload_completed",
            "accepted",
        )?;
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
        record_asset_audit(
            &connection,
            principal.tenant_id,
            Some(document_id),
            Some(asset_id),
            "asset_attached",
            "accepted",
        )?;
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
        // Grant rows are only authorization state. Prune expired rows before a
        // new token is issued so retries cannot leave an unbounded credential
        // index behind.
        connection
            .execute(
                "DELETE FROM download_grants WHERE expires_at_seconds < ?1",
                params![now_seconds],
            )
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
                    record_asset_audit(
                        &connection,
                        principal.tenant_id,
                        Some(document_id),
                        Some(asset_id),
                        "download_grant_issued",
                        "accepted",
                    )?;
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

    /// Idempotent maintenance hook for a scheduler. It never touches an Asset
    /// object or Document attachment; it only removes credentials which could
    /// no longer authorize a download.
    pub fn purge_expired_download_grants(
        &self,
        now_seconds: u64,
    ) -> Result<usize, AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        connection
            .execute(
                "DELETE FROM download_grants WHERE expires_at_seconds < ?1",
                params![now_seconds],
            )
            .map_err(|_| AssetServiceError::Storage)
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
        let asset = load_asset(&connection, stored.2)?.ok_or(AssetServiceError::AssetMissing)?;
        let bytes = self
            .object_store
            .get(AssetObjectKey {
                tenant_id: asset.tenant_id,
                content_hash: asset.content_hash,
            })?
            .ok_or(AssetServiceError::AssetMissing)?;
        record_asset_audit(
            &connection,
            principal.tenant_id,
            Some(grant.document_id),
            Some(asset.asset_id),
            "asset_downloaded",
            "accepted",
        )?;
        Ok((asset, bytes))
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

    /// Returns only audit metadata visible to the trusted tenant. The sequence
    /// supports durable, incremental collection without exposing object data.
    pub fn audit_events(
        &self,
        principal: TrustedPrincipal,
        after_sequence: i64,
    ) -> Result<Vec<AssetAuditEvent>, AssetServiceError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        connection
            .prepare("SELECT sequence, tenant_id, document_id, asset_id, action, outcome, at_seconds FROM asset_audit_events WHERE tenant_id = ?1 AND sequence > ?2 ORDER BY sequence")
            .map_err(|_| AssetServiceError::Storage)?
            .query_map(params![principal.tenant_id.as_slice(), after_sequence], |row| {
                Ok(AssetAuditEvent {
                    sequence: row.get(0)?,
                    tenant_id: id_from_vec(row.get(1)?)?,
                    document_id: row.get::<_, Option<Vec<u8>>>(2)?.map(id_from_vec).transpose()?,
                    asset_id: row.get::<_, Option<Vec<u8>>>(3)?.map(id_from_vec).transpose()?,
                    action: row.get(4)?,
                    outcome: row.get(5)?,
                    at_seconds: row.get(6)?,
                })
            })
            .map_err(|_| AssetServiceError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetServiceError::Storage)
    }

    /// Returns a bounded, tenant-isolated audit page suitable for an HTTP
    /// collector. The cursor is a durable sequence rather than a timestamp, so
    /// equal-time events cannot be lost or duplicated at a page boundary.
    pub fn audit_events_page(
        &self,
        principal: TrustedPrincipal,
        after_sequence: i64,
        limit: usize,
    ) -> Result<Vec<AssetAuditEvent>, AssetServiceError> {
        let limit = limit.clamp(1, MAX_AUDIT_EVENT_PAGE_SIZE);
        let connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        connection
            .prepare("SELECT sequence, tenant_id, document_id, asset_id, action, outcome, at_seconds FROM asset_audit_events WHERE tenant_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT ?3")
            .map_err(|_| AssetServiceError::Storage)?
            .query_map(params![principal.tenant_id.as_slice(), after_sequence, limit], |row| {
                Ok(AssetAuditEvent {
                    sequence: row.get(0)?,
                    tenant_id: id_from_vec(row.get(1)?)?,
                    document_id: row.get::<_, Option<Vec<u8>>>(2)?.map(id_from_vec).transpose()?,
                    asset_id: row.get::<_, Option<Vec<u8>>>(3)?.map(id_from_vec).transpose()?,
                    action: row.get(4)?,
                    outcome: row.get(5)?,
                    at_seconds: row.get(6)?,
                })
            })
            .map_err(|_| AssetServiceError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetServiceError::Storage)
    }

    /// Removes only expired credentials and stale, still-unattached upload
    /// state. Unattached objects are first atomically removed from metadata and
    /// placed in a durable deletion queue; `drain_object_cleanup_queue` then
    /// retries physical deletion until it succeeds.
    pub fn run_maintenance(
        &self,
        now_seconds: u64,
        max_upload_age_seconds: u64,
        max_unattached_asset_age_seconds: u64,
    ) -> Result<AssetCleanupReport, AssetServiceError> {
        let upload_cutoff = now_seconds.saturating_sub(max_upload_age_seconds);
        let asset_cutoff = now_seconds.saturating_sub(max_unattached_asset_age_seconds);
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AssetServiceError::Storage)?;
        let expired_grants = transaction
            .execute(
                "DELETE FROM download_grants WHERE expires_at_seconds < ?1",
                params![now_seconds],
            )
            .map_err(|_| AssetServiceError::Storage)?;
        let abandoned_uploads = transaction
            .execute(
                "DELETE FROM upload_sessions WHERE created_at_seconds < ?1",
                params![upload_cutoff],
            )
            .map_err(|_| AssetServiceError::Storage)?;
        let orphaned = transaction
            .prepare("SELECT tenant_id, content_hash, asset_id FROM assets WHERE created_at_seconds < ?1 AND NOT EXISTS (SELECT 1 FROM document_assets WHERE document_assets.asset_id = assets.asset_id)")
            .map_err(|_| AssetServiceError::Storage)?
            .query_map(params![asset_cutoff], |row| {
                Ok((id_from_vec(row.get(0)?)?, hash_from_vec(row.get(1)?)?, id_from_vec(row.get(2)?)?))
            })
            .map_err(|_| AssetServiceError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetServiceError::Storage)?;
        for (tenant_id, content_hash, asset_id) in &orphaned {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO object_cleanup_queue (tenant_id, content_hash) VALUES (?1, ?2)",
                    params![tenant_id.as_slice(), content_hash.as_slice()],
                )
                .map_err(|_| AssetServiceError::Storage)?;
            transaction
                .execute(
                    "DELETE FROM assets WHERE asset_id = ?1",
                    params![asset_id.as_slice()],
                )
                .map_err(|_| AssetServiceError::Storage)?;
        }
        transaction
            .commit()
            .map_err(|_| AssetServiceError::Storage)?;
        let mut report = AssetCleanupReport {
            expired_grants,
            abandoned_uploads,
            queued_orphaned_objects: orphaned.len(),
            ..AssetCleanupReport::default()
        };
        drop(connection);
        report.deleted_orphaned_objects = self.drain_object_cleanup_queue()?;
        Ok(report)
    }

    /// Safe to call repeatedly after a storage failure; a row leaves the queue
    /// only after its corresponding object store delete reports success. A
    /// content hash can be uploaded again after an earlier orphan was queued,
    /// so every drain item rechecks metadata while holding the SQLite write
    /// lock before deleting the physical object.
    pub fn drain_object_cleanup_queue(&self) -> Result<usize, AssetServiceError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| AssetServiceError::Storage)?;
        let queued = connection
            .prepare("SELECT tenant_id, content_hash FROM object_cleanup_queue")
            .map_err(|_| AssetServiceError::Storage)?
            .query_map([], |row| {
                Ok((id_from_vec(row.get(0)?)?, hash_from_vec(row.get(1)?)?))
            })
            .map_err(|_| AssetServiceError::Storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AssetServiceError::Storage)?;
        let mut deleted = 0;
        for (tenant_id, content_hash) in queued {
            // Keep the reference check, object deletion and queue deletion in
            // one serialized maintenance window. Without this, a retry that
            // restores the same content hash between queueing and draining
            // could have its newly written object deleted.
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| AssetServiceError::Storage)?;
            let referenced = transaction
                .query_row(
                    "SELECT 1 FROM assets WHERE tenant_id = ?1 AND content_hash = ?2 LIMIT 1",
                    params![tenant_id.as_slice(), content_hash.as_slice()],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|_| AssetServiceError::Storage)?
                .is_some();
            if referenced {
                transaction
                    .execute(
                        "DELETE FROM object_cleanup_queue WHERE tenant_id = ?1 AND content_hash = ?2",
                        params![tenant_id.as_slice(), content_hash.as_slice()],
                    )
                    .map_err(|_| AssetServiceError::Storage)?;
                transaction.commit().map_err(|_| AssetServiceError::Storage)?;
                continue;
            }
            self.object_store.delete(AssetObjectKey {
                tenant_id,
                content_hash,
            })?;
            transaction
                .execute(
                    "DELETE FROM object_cleanup_queue WHERE tenant_id = ?1 AND content_hash = ?2",
                    params![tenant_id.as_slice(), content_hash.as_slice()],
                )
                .map_err(|_| AssetServiceError::Storage)?;
            transaction.commit().map_err(|_| AssetServiceError::Storage)?;
            deleted += 1;
        }
        Ok(deleted)
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

fn migrate_legacy_asset_blobs(
    connection: &Connection,
    object_store: &dyn AssetObjectStore,
) -> Result<bool, AssetServiceError> {
    let columns = connection
        .prepare("PRAGMA table_info(assets)")
        .map_err(|_| AssetServiceError::Storage)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| AssetServiceError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AssetServiceError::Storage)?;
    let has_legacy_blob = columns.iter().any(|column| column == "object_bytes");
    if !columns.iter().any(|column| column == "object_key") {
        connection
            .execute("ALTER TABLE assets ADD COLUMN object_key TEXT", [])
            .map_err(|_| AssetServiceError::Storage)?;
    }
    if !has_legacy_blob {
        return Ok(false);
    }
    let legacy_rows = connection
        .prepare("SELECT asset_id, tenant_id, content_hash, object_bytes FROM assets WHERE object_key IS NULL")
        .map_err(|_| AssetServiceError::Storage)?
        .query_map([], |row| Ok((id_from_vec(row.get(0)?)?, id_from_vec(row.get(1)?)?, hash_from_vec(row.get(2)?)?, row.get::<_, Vec<u8>>(3)?)))
        .map_err(|_| AssetServiceError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AssetServiceError::Storage)?;
    for (asset_id, tenant_id, content_hash, bytes) in legacy_rows {
        let key = AssetObjectKey {
            tenant_id,
            content_hash,
        };
        object_store.put(key, &bytes)?;
        connection
            .execute(
                "UPDATE assets SET object_key = ?2, object_bytes = X'' WHERE asset_id = ?1",
                params![asset_id.as_slice(), object_key_string(key)],
            )
            .map_err(|_| AssetServiceError::Storage)?;
    }
    Ok(true)
}

fn migrate_maintenance_columns(connection: &Connection) -> Result<(), AssetServiceError> {
    ensure_column(
        connection,
        "upload_sessions",
        "created_at_seconds",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "assets",
        "created_at_seconds",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    let now = current_time_seconds();
    connection
        .execute(
            "UPDATE upload_sessions SET created_at_seconds = ?1 WHERE created_at_seconds = 0",
            params![now],
        )
        .map_err(|_| AssetServiceError::Storage)?;
    connection
        .execute(
            "UPDATE assets SET created_at_seconds = ?1 WHERE created_at_seconds = 0",
            params![now],
        )
        .map_err(|_| AssetServiceError::Storage)?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    name: &str,
    definition: &str,
) -> Result<(), AssetServiceError> {
    let columns = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| AssetServiceError::Storage)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| AssetServiceError::Storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AssetServiceError::Storage)?;
    if columns.iter().any(|column| column == name) {
        return Ok(());
    }
    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {name} {definition}"),
            [],
        )
        .map_err(|_| AssetServiceError::Storage)?;
    Ok(())
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

fn record_asset_audit(
    connection: &Connection,
    tenant_id: Id,
    document_id: Option<Id>,
    asset_id: Option<Id>,
    action: &str,
    outcome: &str,
) -> Result<(), AssetServiceError> {
    connection
        .execute(
            "INSERT INTO asset_audit_events (tenant_id, document_id, asset_id, action, outcome, at_seconds) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tenant_id.as_slice(),
                document_id.map(|value| value.to_vec()),
                asset_id.map(|value| value.to_vec()),
                action,
                outcome,
                current_time_seconds(),
            ],
        )
        .map_err(|_| AssetServiceError::Storage)?;
    Ok(())
}

fn record_upload_rejection(
    connection: &Connection,
    tenant_id: Id,
    outcome: &str,
) -> Result<(), AssetServiceError> {
    record_asset_audit(
        connection,
        tenant_id,
        None,
        None,
        "upload_rejected",
        outcome,
    )
}

fn current_time_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
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

/// `ttf-parser` validates the container table directory and each selected face
/// before any font reaches the browser. Bound collection and variation counts
/// keep malformed TTC/variable fonts from becoming an unbounded later task.
fn valid_font(bytes: &[u8]) -> bool {
    const MAX_FONT_FACES: u32 = 16;
    const MAX_FONT_VARIATION_AXES: usize = 32;
    let faces = ttf_parser::fonts_in_collection(bytes).unwrap_or(1);
    if faces == 0 || faces > MAX_FONT_FACES {
        return false;
    }
    (0..faces).all(|index| {
        ttf_parser::Face::parse(bytes, index).is_ok_and(|face| {
            face.number_of_glyphs() > 0
                && face.units_per_em() > 0
                && face.variation_axes().len() as usize <= MAX_FONT_VARIATION_AXES
        })
    })
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

fn object_key_string(key: AssetObjectKey) -> String {
    format!("{}/{}", hex(&key.tenant_id), hex(&key.content_hash))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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
    fn other_tenant_principal(actor: u8) -> TrustedPrincipal {
        TrustedPrincipal {
            tenant_id: id(3),
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
    fn font_request(session: u8, bytes: &[u8]) -> UploadRequest {
        UploadRequest {
            session_id: id(session),
            kind: AssetKind::Font,
            expected_content_hash: Sha256::digest(bytes).into(),
            declared_media_type: "font/ttf".into(),
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
        assert_eq!(service.purge_expired_download_grants(111), Ok(1));
        assert_eq!(service.purge_expired_download_grants(111), Ok(0));
        let events = service.audit_events(principal(7), 0).unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.action.as_str())
                .collect::<Vec<_>>(),
            [
                "upload_started",
                "upload_completed",
                "asset_attached",
                "download_grant_issued",
                "asset_downloaded",
            ]
        );
        assert!(
            events
                .iter()
                .all(|event| event.tenant_id == principal(7).tenant_id)
        );
        // Audit collection is tenant-scoped; it deliberately never exposes an
        // upload session, raw bytes, filename or download token.
        assert_eq!(
            service.audit_events(principal(8), 0).unwrap().len(),
            events.len()
        );
        assert!(
            service
                .audit_events(other_tenant_principal(7), 0)
                .unwrap()
                .is_empty()
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
            service.complete_upload(principal(8), id(10)),
            Err(AssetServiceError::PermissionDenied)
        );
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
        let rejection_outcomes = service
            .audit_events(principal(7), 0)
            .unwrap()
            .into_iter()
            .filter(|event| event.action == "upload_rejected")
            .map(|event| event.outcome)
            .collect::<Vec<_>>();
        assert_eq!(
            rejection_outcomes,
            vec!["permission_denied", "content_hash_mismatch", "mime_mismatch"]
        );
    }

    #[test]
    fn font_uploads_validate_parseable_tables_faces_and_variation_limits() {
        let service = AssetService::in_memory().unwrap();
        let valid = font_test_data::TOFU;
        service
            .begin_upload(principal(7), font_request(12, valid))
            .unwrap();
        service
            .append_chunk(principal(7), id(12), 0, valid)
            .unwrap();
        assert_eq!(
            service
                .complete_upload(principal(7), id(12))
                .unwrap()
                .asset
                .media_type,
            "font/ttf"
        );

        let truncated = [0, 1, 0, 0];
        service
            .begin_upload(principal(7), font_request(13, &truncated))
            .unwrap();
        service
            .append_chunk(principal(7), id(13), 0, &truncated)
            .unwrap();
        assert_eq!(
            service.complete_upload(principal(7), id(13)),
            Err(AssetServiceError::FontInvalid)
        );
        assert_eq!(
            service
                .audit_events(principal(7), 0)
                .unwrap()
                .into_iter()
                .filter(|event| event.action == "upload_rejected")
                .map(|event| event.outcome)
                .collect::<Vec<_>>(),
            vec!["font_invalid"]
        );
    }

    #[test]
    fn object_write_failure_is_retryable_and_never_creates_metadata_without_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalFileObjectStore::open(directory.path()).unwrap());
        let service = AssetService::open_with_store(":memory:", store.clone()).unwrap();
        let bytes = png();
        service
            .begin_upload(principal(7), request(10, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(10), 0, &bytes)
            .unwrap();
        store.fail_next_write();
        assert_eq!(
            service.complete_upload(principal(7), id(10)),
            Err(AssetServiceError::Storage)
        );
        assert_eq!(
            service
                .upload_progress(principal(7), id(10))
                .unwrap()
                .accepted_byte_length,
            bytes.len()
        );
        assert!(
            !service
                .complete_upload(principal(7), id(10))
                .unwrap()
                .deduplicated
        );
    }

    #[test]
    fn metadata_failure_compensates_the_written_object_before_retry() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(LocalFileObjectStore::open(directory.path()).unwrap());
        let service = AssetService::open_with_store(":memory:", store.clone()).unwrap();
        let bytes = png();
        let hash: ContentHash = Sha256::digest(&bytes).into();
        service
            .begin_upload(principal(7), request(10, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(10), 0, &bytes)
            .unwrap();
        {
            let connection = service.connection.lock().unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_asset_insert
                     BEFORE INSERT ON assets
                     BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END;",
                )
                .unwrap();
        }
        assert_eq!(
            service.complete_upload(principal(7), id(10)),
            Err(AssetServiceError::Storage)
        );
        assert_eq!(
            store
                .get(AssetObjectKey {
                    tenant_id: principal(7).tenant_id,
                    content_hash: hash,
                })
                .unwrap(),
            None
        );
        assert_eq!(
            service
                .upload_progress(principal(7), id(10))
                .unwrap()
                .accepted_byte_length,
            bytes.len()
        );
        {
            let connection = service.connection.lock().unwrap();
            connection
                .execute_batch("DROP TRIGGER reject_asset_insert;")
                .unwrap();
        }
        assert!(
            !service
                .complete_upload(principal(7), id(10))
                .unwrap()
                .deduplicated
        );
    }

    #[test]
    fn maintenance_queues_orphans_and_removes_abandoned_uploads_without_touching_attachments() {
        let service = AssetService::in_memory().unwrap();
        let bytes = png();
        service
            .begin_upload(principal(7), request(10, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(10), 0, &bytes)
            .unwrap();
        let orphan = service.complete_upload(principal(7), id(10)).unwrap().asset;
        service
            .begin_upload(principal(7), request(11, &bytes))
            .unwrap();
        let document = id(3);
        service
            .grant_document_writer(id(2), document, id(7))
            .unwrap();
        {
            let connection = service.connection.lock().unwrap();
            connection
                .execute("UPDATE assets SET created_at_seconds = 0", [])
                .unwrap();
            connection
                .execute("UPDATE upload_sessions SET created_at_seconds = 0", [])
                .unwrap();
        }
        assert_eq!(
            service.run_maintenance(100, 10, 10).unwrap(),
            AssetCleanupReport {
                expired_grants: 0,
                abandoned_uploads: 1,
                queued_orphaned_objects: 1,
                deleted_orphaned_objects: 1,
            }
        );
        assert_eq!(
            service.upload_progress(principal(7), id(11)),
            Err(AssetServiceError::SessionMissing)
        );
        assert_eq!(
            service.attach_asset_to_document(principal(7), document, orphan.asset_id),
            Err(AssetServiceError::AssetMissing)
        );
        assert_eq!(service.drain_object_cleanup_queue(), Ok(0));
    }

    #[test]
    fn queued_orphan_cleanup_never_deletes_a_reuploaded_content_hash() {
        let store = Arc::new(InMemoryObjectStore(Mutex::new(HashMap::new())));
        let service = AssetService::from_connection(
            Connection::open_in_memory().unwrap(),
            store.clone(),
        )
        .unwrap();
        let bytes = png();
        let hash: ContentHash = Sha256::digest(&bytes).into();

        service
            .begin_upload(principal(7), request(10, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(10), 0, &bytes)
            .unwrap();
        let original = service.complete_upload(principal(7), id(10)).unwrap().asset;
        {
            let connection = service.connection.lock().unwrap();
            connection
                .execute(
                    "INSERT INTO object_cleanup_queue (tenant_id, content_hash) VALUES (?1, ?2)",
                    params![principal(7).tenant_id.as_slice(), hash.as_slice()],
                )
                .unwrap();
            connection
                .execute(
                    "DELETE FROM assets WHERE asset_id = ?1",
                    params![original.asset_id.as_slice()],
                )
                .unwrap();
        }

        service
            .begin_upload(principal(7), request(11, &bytes))
            .unwrap();
        service
            .append_chunk(principal(7), id(11), 0, &bytes)
            .unwrap();
        let restored = service.complete_upload(principal(7), id(11)).unwrap().asset;
        assert_eq!(restored.asset_id, original.asset_id);

        assert_eq!(service.drain_object_cleanup_queue(), Ok(0));
        assert_eq!(
            store
                .get(AssetObjectKey {
                    tenant_id: principal(7).tenant_id,
                    content_hash: hash,
                })
                .unwrap(),
            Some(bytes),
        );
    }

    #[test]
    fn local_file_store_persists_verified_objects_outside_sqlite() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("assets.sqlite");
        let bytes = png();
        let asset = {
            let service = AssetService::open(&database).unwrap();
            service
                .begin_upload(principal(7), request(10, &bytes))
                .unwrap();
            service
                .append_chunk(principal(7), id(10), 0, &bytes)
                .unwrap();
            service.complete_upload(principal(7), id(10)).unwrap().asset
        };
        assert!(database.with_extension("objects").exists());
        let service = AssetService::open(&database).unwrap();
        let document = id(3);
        service
            .grant_document_writer(id(2), document, id(7))
            .unwrap();
        service
            .attach_asset_to_document(principal(7), document, asset.asset_id)
            .unwrap();
        let grant = service
            .issue_download_grant(principal(7), document, asset.asset_id, 100, 10)
            .unwrap();
        assert_eq!(
            service
                .download_with_grant(principal(7), &grant, 100)
                .unwrap()
                .1,
            bytes
        );
    }
}
