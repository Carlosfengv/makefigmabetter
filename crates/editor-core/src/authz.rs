//! Server-side authorization contract for document operations.
//!
//! Browser-provided actor and tenant values are intentionally not trusted. A server
//! resolves a `Principal` and `DocumentPolicy` from its authenticated session/store,
//! then uses this module before handing an operation to the canonical reducer.

use std::collections::BTreeSet;

use crate::{
    ActorId, AppliedOperation, CommandError, Document, DocumentId, OperationEnvelope, OperationId,
    Origin,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TenantId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Principal {
    pub tenant_id: TenantId,
    pub actor_id: ActorId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPolicy {
    pub tenant_id: TenantId,
    pub document_id: DocumentId,
    pub editors: BTreeSet<ActorId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationError {
    TenantMismatch,
    DocumentMismatch,
    WriteDenied,
    PolicyDoesNotMatchLoadedDocument,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizedOperationError {
    Authorization(AuthorizationError),
    Command(CommandError),
}

pub const AUTHORIZATION_AUDIT_SCHEMA_VERSION: u32 = 1;

/// Structured audit evidence intended for a trusted server-side sink. It omits the
/// untrusted transport actor, operation payload, node content, and error strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthorizationAuditEvent {
    pub schema_version: u32,
    pub tenant_id: TenantId,
    pub authenticated_actor_id: ActorId,
    pub requested_document_id: DocumentId,
    pub loaded_document_id: DocumentId,
    pub operation_id: OperationId,
    pub revision_before: u64,
    pub accepted_revision: Option<u64>,
    pub outcome: AuthorizationAuditOutcome,
    pub code: AuthorizationAuditCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationAuditOutcome {
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationAuditCode {
    Accepted,
    TenantMismatch,
    DocumentMismatch,
    WriteDenied,
    PolicyDoesNotMatchLoadedDocument,
    OperationRejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditedAuthorizedOperation {
    pub result: Result<AppliedOperation, AuthorizedOperationError>,
    pub audit: AuthorizationAuditEvent,
}

/// Turns an untrusted transport envelope into a trusted one. The actor is always
/// injected from the authenticated principal, never copied from client input.
pub fn authorize_operation(
    principal: Principal,
    policy: &DocumentPolicy,
    mut operation: OperationEnvelope,
) -> Result<OperationEnvelope, AuthorizationError> {
    if principal.tenant_id != policy.tenant_id {
        return Err(AuthorizationError::TenantMismatch);
    }
    if operation.document_id != policy.document_id {
        return Err(AuthorizationError::DocumentMismatch);
    }
    if !policy.editors.contains(&principal.actor_id) {
        return Err(AuthorizationError::WriteDenied);
    }
    operation.actor_id = principal.actor_id;
    Ok(operation)
}

impl Document {
    pub fn submit_authorized_operation(
        &mut self,
        principal: Principal,
        policy: &DocumentPolicy,
        operation: OperationEnvelope,
    ) -> Result<AppliedOperation, AuthorizedOperationError> {
        if policy.document_id != self.id() {
            return Err(AuthorizedOperationError::Authorization(
                AuthorizationError::PolicyDoesNotMatchLoadedDocument,
            ));
        }
        let operation = authorize_operation(principal, policy, operation)
            .map_err(AuthorizedOperationError::Authorization)?;
        self.submit_operation(operation, Origin::RemoteOperation)
            .map_err(AuthorizedOperationError::Command)
    }

    /// Applies the established authorization contract and returns a privacy-safe,
    /// server-side audit event alongside the result. Rejections retain the exact
    /// non-mutation semantics of `submit_authorized_operation`.
    pub fn submit_authorized_operation_with_audit(
        &mut self,
        principal: Principal,
        policy: &DocumentPolicy,
        operation: OperationEnvelope,
    ) -> AuditedAuthorizedOperation {
        let requested_document_id = operation.document_id;
        let operation_id = operation.operation_id;
        let revision_before = self.revision;
        let result = self.submit_authorized_operation(principal, policy, operation);
        let (outcome, code, accepted_revision) = match &result {
            Ok(applied) => (
                AuthorizationAuditOutcome::Accepted,
                AuthorizationAuditCode::Accepted,
                Some(applied.accepted_revision),
            ),
            Err(AuthorizedOperationError::Authorization(AuthorizationError::TenantMismatch)) => (
                AuthorizationAuditOutcome::Rejected,
                AuthorizationAuditCode::TenantMismatch,
                None,
            ),
            Err(AuthorizedOperationError::Authorization(AuthorizationError::DocumentMismatch)) => (
                AuthorizationAuditOutcome::Rejected,
                AuthorizationAuditCode::DocumentMismatch,
                None,
            ),
            Err(AuthorizedOperationError::Authorization(AuthorizationError::WriteDenied)) => (
                AuthorizationAuditOutcome::Rejected,
                AuthorizationAuditCode::WriteDenied,
                None,
            ),
            Err(AuthorizedOperationError::Authorization(
                AuthorizationError::PolicyDoesNotMatchLoadedDocument,
            )) => (
                AuthorizationAuditOutcome::Rejected,
                AuthorizationAuditCode::PolicyDoesNotMatchLoadedDocument,
                None,
            ),
            Err(AuthorizedOperationError::Command(_)) => (
                AuthorizationAuditOutcome::Rejected,
                AuthorizationAuditCode::OperationRejected,
                None,
            ),
        };
        AuditedAuthorizedOperation {
            result,
            audit: AuthorizationAuditEvent {
                schema_version: AUTHORIZATION_AUDIT_SCHEMA_VERSION,
                tenant_id: principal.tenant_id,
                authenticated_actor_id: principal.actor_id,
                requested_document_id,
                loaded_document_id: self.id(),
                operation_id,
                revision_before,
                accepted_revision,
                outcome,
                code,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Command, Node, NodeId, NodeKind, OperationId, PositionId, Transaction, TransactionId,
    };

    fn node(id: u128) -> Node {
        Node {
            id: NodeId(id),
            parent_id: None,
            position: PositionId::for_node(NodeId(id)),
            name: "Authorized".into(),
            kind: NodeKind::Rectangle,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 80.0,
            rotation: 0.0,
            fill: "#fff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 0.0,
            text: String::new(),
            visible: true,
            locked: false,
        }
    }

    fn operation(document_id: DocumentId, actor_id: ActorId) -> OperationEnvelope {
        OperationEnvelope::new(
            document_id,
            OperationId(55),
            actor_id,
            vec![],
            Transaction {
                id: TransactionId(56),
                base_revision: 0,
                commands: vec![Command::Create(node(1))],
            },
        )
    }

    #[test]
    fn authenticated_actor_overrides_a_forged_transport_actor() {
        let document_id = DocumentId(1);
        let trusted = ActorId(7);
        let principal = Principal {
            tenant_id: TenantId(2),
            actor_id: trusted,
        };
        let policy = DocumentPolicy {
            tenant_id: TenantId(2),
            document_id,
            editors: BTreeSet::from([trusted]),
        };
        let authorized =
            authorize_operation(principal, &policy, operation(document_id, ActorId(999))).unwrap();

        assert_eq!(authorized.actor_id, trusted);
        let mut document = Document::with_id(document_id);
        document
            .submit_authorized_operation(principal, &policy, authorized)
            .unwrap();
        assert_eq!(document.revision, 1);
        assert!(document.node(NodeId(1)).is_some());
    }

    #[test]
    fn rejects_cross_tenant_cross_document_and_ungranted_writes_without_mutation() {
        let document_id = DocumentId(1);
        let actor = ActorId(7);
        let policy = DocumentPolicy {
            tenant_id: TenantId(2),
            document_id,
            editors: BTreeSet::from([actor]),
        };
        assert_eq!(
            authorize_operation(
                Principal {
                    tenant_id: TenantId(3),
                    actor_id: actor
                },
                &policy,
                operation(document_id, actor)
            ),
            Err(AuthorizationError::TenantMismatch)
        );
        assert_eq!(
            authorize_operation(
                Principal {
                    tenant_id: TenantId(2),
                    actor_id: actor
                },
                &policy,
                operation(DocumentId(9), actor)
            ),
            Err(AuthorizationError::DocumentMismatch)
        );
        assert_eq!(
            authorize_operation(
                Principal {
                    tenant_id: TenantId(2),
                    actor_id: ActorId(8)
                },
                &policy,
                operation(document_id, ActorId(8))
            ),
            Err(AuthorizationError::WriteDenied)
        );

        let mut document = Document::with_id(document_id);
        let mismatch = DocumentPolicy {
            document_id: DocumentId(9),
            ..policy
        };
        assert_eq!(
            document.submit_authorized_operation(
                Principal {
                    tenant_id: TenantId(2),
                    actor_id: actor
                },
                &mismatch,
                operation(document_id, actor)
            ),
            Err(AuthorizedOperationError::Authorization(
                AuthorizationError::PolicyDoesNotMatchLoadedDocument
            ))
        );
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn audit_event_uses_the_trusted_principal_and_preserves_rejection_non_mutation() {
        let document_id = DocumentId(1);
        let trusted = ActorId(7);
        let principal = Principal {
            tenant_id: TenantId(2),
            actor_id: trusted,
        };
        let policy = DocumentPolicy {
            tenant_id: TenantId(2),
            document_id,
            editors: BTreeSet::from([trusted]),
        };
        let mut document = Document::with_id(document_id);

        let accepted = document.submit_authorized_operation_with_audit(
            principal,
            &policy,
            operation(document_id, ActorId(999)),
        );
        assert!(accepted.result.is_ok());
        assert_eq!(
            accepted.audit,
            AuthorizationAuditEvent {
                schema_version: AUTHORIZATION_AUDIT_SCHEMA_VERSION,
                tenant_id: TenantId(2),
                authenticated_actor_id: trusted,
                requested_document_id: document_id,
                loaded_document_id: document_id,
                operation_id: OperationId(55),
                revision_before: 0,
                accepted_revision: Some(1),
                outcome: AuthorizationAuditOutcome::Accepted,
                code: AuthorizationAuditCode::Accepted,
            }
        );

        let denied = document.submit_authorized_operation_with_audit(
            Principal {
                tenant_id: TenantId(2),
                actor_id: ActorId(8),
            },
            &policy,
            operation(document_id, ActorId(999)),
        );
        assert_eq!(
            denied.result,
            Err(AuthorizedOperationError::Authorization(
                AuthorizationError::WriteDenied
            ))
        );
        assert_eq!(denied.audit.outcome, AuthorizationAuditOutcome::Rejected);
        assert_eq!(denied.audit.code, AuthorizationAuditCode::WriteDenied);
        assert_eq!(denied.audit.authenticated_actor_id, ActorId(8));
        assert_eq!(document.revision, 1);
    }
}
