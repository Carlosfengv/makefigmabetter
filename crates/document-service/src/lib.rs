//! Durable, single-primary Document Service foundation.
//!
//! This crate owns the accepted-revision transaction and stores original protobuf
//! envelope bytes. A `CanonicalReducer` supplies document-specific schema/reference
//! validation and the next snapshot; gateways must never decode/re-encode an
//! envelope merely to forward it.

use std::path::Path;
use std::sync::Mutex;

use makefigma_protocol::{PROTOCOL_VERSION, v1};
use prost::Message;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

pub mod core_snapshot_adapter;
pub mod operation_adapter;

pub const MAX_OPERATION_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;

pub type Id = [u8; 16];
pub type Hash = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedPrincipal {
    pub tenant_id: Id,
    pub actor_id: Id,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentState {
    pub document_id: Id,
    pub tenant_id: Id,
    pub accepted_revision: u64,
    pub document_hash: Hash,
    pub snapshot: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ReductionInput<'a> {
    pub principal: TrustedPrincipal,
    pub operation: &'a v1::OperationEnvelope,
    pub raw_envelope: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReducedDocument {
    pub snapshot: Vec<u8>,
    pub document_hash: Hash,
}

/// The concrete editor-core adapter belongs here once protobuf operation payloads
/// are fully mapped. Keeping this as a narrow trait prevents transport or database
/// code from becoming a second document reducer.
pub trait CanonicalReducer: Send + Sync + 'static {
    fn apply(
        &self,
        current: &DocumentState,
        input: ReductionInput<'_>,
    ) -> Result<ReducedDocument, ServiceError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitReceipt {
    pub accepted_revision: u64,
    pub document_hash: Hash,
    pub idempotent_replay: bool,
}

impl SubmitReceipt {
    pub fn ack(&self, document_id: Id, operation_id: Id) -> v1::OperationAck {
        v1::OperationAck {
            schema_version: 1,
            document_id: document_id.to_vec(),
            operation_id: operation_id.to_vec(),
            result: v1::AckResult::Accepted as i32,
            accepted_revision: Some(self.accepted_revision),
            document_hash: Some(self.document_hash.to_vec()),
            canonical_operation: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    ProtocolVersionUnsupported,
    InvalidEnvelope,
    HashMismatch,
    PermissionDenied,
    MissingDocument,
    BaseRevisionConflict { expected: u64, actual: u64 },
    OperationIdConflict,
    ResourceLimit,
    ReducerRejected,
    Storage,
}

impl ServiceError {
    pub fn protocol_error(&self) -> v1::ProtocolError {
        let (code, safe_message) = match self {
            Self::ProtocolVersionUnsupported => (
                v1::ErrorCode::ProtocolVersionUnsupported,
                "Unsupported protocol version.",
            ),
            Self::InvalidEnvelope => (
                v1::ErrorCode::InvalidEnvelope,
                "Invalid operation envelope.",
            ),
            Self::HashMismatch => (
                v1::ErrorCode::HashMismatch,
                "Operation payload hash does not match.",
            ),
            Self::PermissionDenied => (
                v1::ErrorCode::PermissionDenied,
                "You do not have permission to edit this document.",
            ),
            Self::MissingDocument => (v1::ErrorCode::InvalidEnvelope, "Document does not exist."),
            Self::BaseRevisionConflict { .. } => (
                v1::ErrorCode::BaseRevisionConflict,
                "Document revision is no longer current.",
            ),
            Self::OperationIdConflict => (
                v1::ErrorCode::InvalidEnvelope,
                "Operation ID was reused with a different payload.",
            ),
            Self::ResourceLimit => (
                v1::ErrorCode::ResourceLimit,
                "Operation exceeds a resource limit.",
            ),
            Self::ReducerRejected => (
                v1::ErrorCode::InvalidEnvelope,
                "Operation could not be applied.",
            ),
            Self::Storage => (
                v1::ErrorCode::Internal,
                "Document service storage is unavailable.",
            ),
        };
        v1::ProtocolError {
            code: code as i32,
            safe_message: safe_message.into(),
            supported_protocol_versions: Some(v1::VersionRange {
                min_protocol_version: PROTOCOL_VERSION,
                max_protocol_version: PROTOCOL_VERSION,
            }),
            minimum_engine_semantics_version: None,
            details: Default::default(),
        }
    }
}

pub struct DocumentService<R> {
    connection: Mutex<Connection>,
    reducer: R,
}

impl<R: CanonicalReducer> DocumentService<R> {
    pub fn open(path: impl AsRef<Path>, reducer: R) -> Result<Self, ServiceError> {
        let connection = Connection::open(path).map_err(|_| ServiceError::Storage)?;
        Self::from_connection(connection, reducer)
    }

    pub fn in_memory(reducer: R) -> Result<Self, ServiceError> {
        let connection = Connection::open_in_memory().map_err(|_| ServiceError::Storage)?;
        Self::from_connection(connection, reducer)
    }

    fn from_connection(connection: Connection, reducer: R) -> Result<Self, ServiceError> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS documents (
               document_id BLOB PRIMARY KEY NOT NULL CHECK(length(document_id) = 16),
               tenant_id BLOB NOT NULL CHECK(length(tenant_id) = 16),
               accepted_revision INTEGER NOT NULL,
               document_hash BLOB NOT NULL CHECK(length(document_hash) = 32),
               snapshot BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS document_editors (
               document_id BLOB NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
               actor_id BLOB NOT NULL CHECK(length(actor_id) = 16),
               PRIMARY KEY (document_id, actor_id)
             );
             CREATE TABLE IF NOT EXISTS operations (
               document_id BLOB NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
               operation_id BLOB NOT NULL CHECK(length(operation_id) = 16),
               payload_hash BLOB NOT NULL CHECK(length(payload_hash) = 32),
               accepted_revision INTEGER NOT NULL,
               document_hash BLOB NOT NULL CHECK(length(document_hash) = 32),
               envelope BLOB NOT NULL,
               PRIMARY KEY (document_id, operation_id),
               UNIQUE (document_id, accepted_revision)
             );",
            )
            .map_err(|_| ServiceError::Storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
            reducer,
        })
    }

    pub fn create_document(
        &self,
        state: DocumentState,
        editors: &[Id],
    ) -> Result<(), ServiceError> {
        if state.snapshot.len() > MAX_SNAPSHOT_BYTES {
            return Err(ServiceError::ResourceLimit);
        }
        let mut connection = self.connection.lock().map_err(|_| ServiceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ServiceError::Storage)?;
        transaction.execute(
            "INSERT INTO documents (document_id, tenant_id, accepted_revision, document_hash, snapshot) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![state.document_id.as_slice(), state.tenant_id.as_slice(), state.accepted_revision, state.document_hash.as_slice(), state.snapshot],
        ).map_err(|_| ServiceError::Storage)?;
        for editor in editors {
            transaction
                .execute(
                    "INSERT INTO document_editors (document_id, actor_id) VALUES (?1, ?2)",
                    params![state.document_id.as_slice(), editor.as_slice()],
                )
                .map_err(|_| ServiceError::Storage)?;
        }
        transaction.commit().map_err(|_| ServiceError::Storage)
    }

    pub fn load_document(&self, document_id: Id) -> Result<DocumentState, ServiceError> {
        let connection = self.connection.lock().map_err(|_| ServiceError::Storage)?;
        load_document(&connection, document_id)?.ok_or(ServiceError::MissingDocument)
    }

    /// Read access is intentionally checked at the service boundary as well as
    /// write access. Phase 1 uses the editor set for the single-client reader
    /// policy; a future viewer role can widen this without weakening isolation.
    pub fn can_read_document(
        &self,
        principal: TrustedPrincipal,
        document_id: Id,
    ) -> Result<bool, ServiceError> {
        let connection = self.connection.lock().map_err(|_| ServiceError::Storage)?;
        let document = match load_document(&connection, document_id)? {
            Some(document) => document,
            None => return Ok(false),
        };
        if document.tenant_id != principal.tenant_id {
            return Ok(false);
        }
        connection
            .query_row(
                "SELECT 1 FROM document_editors WHERE document_id = ?1 AND actor_id = ?2",
                params![document_id.as_slice(), principal.actor_id.as_slice()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| ServiceError::Storage)
            .map(|row| row.is_some())
    }

    pub fn submit(
        &self,
        principal: TrustedPrincipal,
        raw_envelope: &[u8],
    ) -> Result<SubmitReceipt, ServiceError> {
        if raw_envelope.len() > MAX_OPERATION_BYTES {
            return Err(ServiceError::ResourceLimit);
        }
        let mut operation = v1::OperationEnvelope::decode(raw_envelope)
            .map_err(|_| ServiceError::InvalidEnvelope)?;
        validate_envelope(&operation)?;
        let document_id = id_from_bytes(&operation.document_id)?;
        let operation_id = id_from_bytes(&operation.operation_id)?;
        let payload_hash = hash_from_bytes(&operation.payload_hash)?;

        let mut connection = self.connection.lock().map_err(|_| ServiceError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| ServiceError::Storage)?;
        let current =
            load_document(&transaction, document_id)?.ok_or(ServiceError::MissingDocument)?;
        if current.tenant_id != principal.tenant_id {
            return Err(ServiceError::PermissionDenied);
        }
        // Client envelope identity is transport metadata, not an authorization
        // source. Preserve the original raw bytes for opaque forwarding/audit, but
        // pass only the authenticated actor into the canonical reducer.
        operation.actor_id = principal.actor_id.to_vec();
        let editor = transaction
            .query_row(
                "SELECT 1 FROM document_editors WHERE document_id = ?1 AND actor_id = ?2",
                params![document_id.as_slice(), principal.actor_id.as_slice()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| ServiceError::Storage)?;
        if editor.is_none() {
            return Err(ServiceError::PermissionDenied);
        }

        if let Some((stored_hash, accepted_revision, document_hash)) = transaction.query_row(
            "SELECT payload_hash, accepted_revision, document_hash FROM operations WHERE document_id = ?1 AND operation_id = ?2",
            params![document_id.as_slice(), operation_id.as_slice()],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, u64>(1)?, row.get::<_, Vec<u8>>(2)?)),
        ).optional().map_err(|_| ServiceError::Storage)? {
            if stored_hash.as_slice() != payload_hash { return Err(ServiceError::OperationIdConflict); }
            return Ok(SubmitReceipt { accepted_revision, document_hash: hash_from_bytes(&document_hash)?, idempotent_replay: true });
        }
        if operation.base_revision != current.accepted_revision {
            return Err(ServiceError::BaseRevisionConflict {
                expected: current.accepted_revision,
                actual: operation.base_revision,
            });
        }

        let reduced = self.reducer.apply(
            &current,
            ReductionInput {
                principal,
                operation: &operation,
                raw_envelope,
            },
        )?;
        if reduced.snapshot.len() > MAX_SNAPSHOT_BYTES {
            return Err(ServiceError::ResourceLimit);
        }
        let accepted_revision = current
            .accepted_revision
            .checked_add(1)
            .ok_or(ServiceError::ResourceLimit)?;
        transaction.execute(
            "UPDATE documents SET accepted_revision = ?2, document_hash = ?3, snapshot = ?4 WHERE document_id = ?1",
            params![document_id.as_slice(), accepted_revision, reduced.document_hash.as_slice(), reduced.snapshot],
        ).map_err(|_| ServiceError::Storage)?;
        transaction.execute(
            "INSERT INTO operations (document_id, operation_id, payload_hash, accepted_revision, document_hash, envelope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![document_id.as_slice(), operation_id.as_slice(), payload_hash.as_slice(), accepted_revision, reduced.document_hash.as_slice(), raw_envelope],
        ).map_err(|_| ServiceError::Storage)?;
        transaction.commit().map_err(|_| ServiceError::Storage)?;
        Ok(SubmitReceipt {
            accepted_revision,
            document_hash: reduced.document_hash,
            idempotent_replay: false,
        })
    }
}

fn load_document(
    connection: &Connection,
    document_id: Id,
) -> Result<Option<DocumentState>, ServiceError> {
    connection.query_row(
        "SELECT tenant_id, accepted_revision, document_hash, snapshot FROM documents WHERE document_id = ?1",
        params![document_id.as_slice()],
        |row| {
            let tenant_id = id_from_bytes(&row.get::<_, Vec<u8>>(0)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let document_hash = hash_from_bytes(&row.get::<_, Vec<u8>>(2)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(DocumentState {
                document_id,
                tenant_id,
                accepted_revision: row.get(1)?,
                document_hash,
                snapshot: row.get(3)?,
            })
        },
    ).optional().map_err(|_| ServiceError::Storage)
}

fn id_from_bytes(value: &[u8]) -> Result<Id, ServiceError> {
    value.try_into().map_err(|_| ServiceError::InvalidEnvelope)
}

fn hash_from_bytes(value: &[u8]) -> Result<Hash, ServiceError> {
    value.try_into().map_err(|_| ServiceError::InvalidEnvelope)
}

fn validate_envelope(operation: &v1::OperationEnvelope) -> Result<(), ServiceError> {
    if operation.schema_version != 1 {
        return Err(ServiceError::ProtocolVersionUnsupported);
    }
    for id in [
        &operation.document_id,
        &operation.operation_id,
        &operation.transaction_id,
        &operation.actor_id,
        &operation.session_id,
    ] {
        id_from_bytes(id)?;
    }
    for id in &operation.causal_parent_ids {
        id_from_bytes(id)?;
    }
    if operation.payload.is_empty() {
        return Err(ServiceError::InvalidEnvelope);
    }
    let expected = hash_from_bytes(&operation.payload_hash)?;
    let actual: Hash = Sha256::digest(&operation.payload).into();
    if actual != expected {
        return Err(ServiceError::HashMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[derive(Clone)]
    struct TestReducer {
        calls: Arc<AtomicUsize>,
    }

    impl CanonicalReducer for TestReducer {
        fn apply(
            &self,
            current: &DocumentState,
            input: ReductionInput<'_>,
        ) -> Result<ReducedDocument, ServiceError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut snapshot = current.snapshot.clone();
            snapshot.extend_from_slice(&input.principal.actor_id);
            snapshot.extend_from_slice(&input.operation.payload);
            Ok(ReducedDocument {
                document_hash: Sha256::digest(&snapshot).into(),
                snapshot,
            })
        }
    }

    fn id(value: u8) -> Id {
        [value; 16]
    }

    fn state() -> DocumentState {
        let snapshot = b"seed".to_vec();
        DocumentState {
            document_id: id(1),
            tenant_id: id(2),
            accepted_revision: 0,
            document_hash: Sha256::digest(&snapshot).into(),
            snapshot,
        }
    }

    fn envelope(operation_id: u8, base_revision: u64, actor_id: u8, payload: &[u8]) -> Vec<u8> {
        v1::OperationEnvelope {
            schema_version: 1,
            document_id: id(1).to_vec(),
            operation_id: id(operation_id).to_vec(),
            transaction_id: id(3).to_vec(),
            actor_id: id(actor_id).to_vec(),
            session_id: id(4).to_vec(),
            client_sequence: 1,
            base_revision,
            causal_parent_ids: vec![],
            payload: payload.into(),
            payload_hash: Sha256::digest(payload).to_vec(),
            engine_semantics_version: Some(3),
        }
        .encode_to_vec()
    }

    #[test]
    fn commits_once_and_replays_idempotently_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("document-service.sqlite");
        let calls = Arc::new(AtomicUsize::new(0));
        let reducer = TestReducer {
            calls: calls.clone(),
        };
        let service = DocumentService::open(&database_path, reducer).unwrap();
        service.create_document(state(), &[id(7)]).unwrap();
        let principal = TrustedPrincipal {
            tenant_id: id(2),
            actor_id: id(7),
        };
        let raw = envelope(9, 0, 99, b"create");
        let accepted = service.submit(principal, &raw).unwrap();
        assert_eq!(accepted.accepted_revision, 1);
        assert!(!accepted.idempotent_replay);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let replay = service.submit(principal, &raw).unwrap();
        assert_eq!(replay.accepted_revision, 1);
        assert!(replay.idempotent_replay);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        drop(service);

        let restarted = DocumentService::open(&database_path, TestReducer { calls }).unwrap();
        assert_eq!(restarted.load_document(id(1)).unwrap().accepted_revision, 1);
        assert!(restarted.submit(principal, &raw).unwrap().idempotent_replay);
    }

    #[test]
    fn rejects_tampering_conflicts_and_untrusted_actor_without_mutation() {
        let calls = Arc::new(AtomicUsize::new(0));
        let service = DocumentService::in_memory(TestReducer {
            calls: calls.clone(),
        })
        .unwrap();
        service.create_document(state(), &[id(7)]).unwrap();
        let principal = TrustedPrincipal {
            tenant_id: id(2),
            actor_id: id(7),
        };
        let mut tampered =
            v1::OperationEnvelope::decode(envelope(9, 0, 99, b"create").as_slice()).unwrap();
        tampered.payload_hash[0] ^= 0xff;
        let corrupted = tampered.encode_to_vec();
        assert_eq!(
            service.submit(principal, &corrupted),
            Err(ServiceError::HashMismatch)
        );
        assert_eq!(service.load_document(id(1)).unwrap().accepted_revision, 0);

        let raw = envelope(9, 0, 99, b"create");
        service.submit(principal, &raw).unwrap();
        assert_eq!(
            service.submit(principal, &envelope(10, 0, 99, b"stale")),
            Err(ServiceError::BaseRevisionConflict {
                expected: 1,
                actual: 0
            })
        );
        assert_eq!(
            service.submit(
                TrustedPrincipal {
                    tenant_id: id(2),
                    actor_id: id(8)
                },
                &envelope(11, 1, 99, b"denied")
            ),
            Err(ServiceError::PermissionDenied)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
