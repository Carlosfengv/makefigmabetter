//! Loopback HTTP adapter for the durable Rust Document Service.
//!
//! The adapter accepts and returns only the generated protobuf wire messages.
//! Authentication is deliberately represented by a small trusted-principal
//! extractor; the local development extractor uses explicit headers and must
//! never be installed as a production authentication mechanism.

use std::sync::Arc;

use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, options, post},
};
use editor_core::{Document, DocumentId};
use makefigma_document_service::{
    DocumentService, Id, MAX_OPERATION_BYTES, MAX_SNAPSHOT_BYTES, ServiceError, TrustedPrincipal,
    core_snapshot_adapter::{CoreOperationReducer, initial_document_state},
};
use makefigma_protocol::v1;
use prost::Message;

pub const ENGINE_SEMANTICS_VERSION: u32 = 3;
pub const PROTOBUF_CONTENT_TYPE: &str = "application/x-protobuf";

#[derive(Clone)]
pub struct ApiState {
    service: Arc<DocumentService<CoreOperationReducer>>,
}

impl ApiState {
    pub fn new(service: DocumentService<CoreOperationReducer>) -> Self {
        Self {
            service: Arc::new(service),
        }
    }
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/v1/documents/{document_id}",
            post(create_document)
                .options(preflight)
                .layer(DefaultBodyLimit::max(MAX_SNAPSHOT_BYTES)),
        )
        .route(
            "/v1/documents/{document_id}/operations",
            post(submit_operation)
                .options(preflight)
                .layer(DefaultBodyLimit::max(MAX_OPERATION_BYTES)),
        )
        .route(
            "/v1/documents/{document_id}/snapshot",
            get(load_snapshot).options(preflight),
        )
        .route("/{*path}", options(preflight))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(state)
}

async fn health() -> Response {
    plain_response(
        StatusCode::OK,
        b"{\"status\":\"ok\",\"service\":\"makefigma-document-api\",\"protocolVersion\":1}"
            .to_vec(),
        "application/json; charset=utf-8",
    )
}

async fn preflight() -> Response {
    cors_response(StatusCode::NO_CONTENT, Vec::new(), PROTOBUF_CONTENT_TYPE)
}

/// Creates an empty document when the body is empty, or atomically adopts a
/// fully validated canonical Protobuf snapshot. This lets an offline-first
/// browser establish its durable remote root without JSON re-serialization.
async fn create_document(
    State(state): State<ApiState>,
    Path(document_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (principal, document_id) = match (dev_principal(&headers), parse_id(&document_id)) {
        (Ok(principal), Ok(document_id)) => (principal, document_id),
        (Err(error), _) | (_, Err(error)) => return protocol_error(error),
    };
    let document = if body.is_empty() {
        Document::with_id(DocumentId(u128::from_be_bytes(document_id)))
    } else {
        match makefigma_document_codec::document_from_wire_snapshot(body.as_ref()) {
            Ok(document) if document.id().0.to_be_bytes() == document_id => document,
            Ok(_) | Err(_) => return protocol_error(ServiceError::InvalidEnvelope),
        }
    };
    match state.service.load_document(document_id) {
        Ok(existing) => {
            if state
                .service
                .can_read_document(principal, document_id)
                .unwrap_or(false)
                && existing.document_hash == document.canonical_hash()
            {
                return plain_response(StatusCode::OK, Vec::new(), PROTOBUF_CONTENT_TYPE);
            }
            return protocol_error(ServiceError::BaseRevisionConflict {
                expected: existing.accepted_revision,
                actual: document.revision,
            });
        }
        Err(ServiceError::MissingDocument) => {}
        Err(error) => return protocol_error(error),
    }
    match initial_document_state(&document, principal.tenant_id, ENGINE_SEMANTICS_VERSION).and_then(
        |initial| {
            state
                .service
                .create_document(initial, &[principal.actor_id])
        },
    ) {
        Ok(()) => plain_response(StatusCode::CREATED, Vec::new(), PROTOBUF_CONTENT_TYPE),
        Err(ServiceError::Storage) => protocol_error(ServiceError::InvalidEnvelope),
        Err(error) => protocol_error(error),
    }
}

async fn submit_operation(
    State(state): State<ApiState>,
    Path(document_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (principal, routed_document_id) = match (dev_principal(&headers), parse_id(&document_id)) {
        (Ok(principal), Ok(document_id)) => (principal, document_id),
        (Err(error), _) | (_, Err(error)) => return protocol_error(error),
    };
    let envelope = match v1::OperationEnvelope::decode(body.as_ref()) {
        Ok(envelope) => envelope,
        Err(_) => return protocol_error(ServiceError::InvalidEnvelope),
    };
    if envelope.document_id.as_slice() != routed_document_id.as_slice() {
        return protocol_error(ServiceError::InvalidEnvelope);
    }
    let operation_id = match envelope.operation_id.as_slice().try_into() as Result<Id, _> {
        Ok(operation_id) => operation_id,
        Err(_) => return protocol_error(ServiceError::InvalidEnvelope),
    };
    match state.service.submit(principal, body.as_ref()) {
        Ok(receipt) => protobuf_response(
            StatusCode::OK,
            receipt
                .ack(routed_document_id, operation_id)
                .encode_to_vec(),
        ),
        Err(error) => protocol_error(error),
    }
}

async fn load_snapshot(
    State(state): State<ApiState>,
    Path(document_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (principal, document_id) = match (dev_principal(&headers), parse_id(&document_id)) {
        (Ok(principal), Ok(document_id)) => (principal, document_id),
        (Err(error), _) | (_, Err(error)) => return protocol_error(error),
    };
    match (
        state.service.load_document(document_id),
        state.service.can_read_document(principal, document_id),
    ) {
        (Ok(document), Ok(true)) => protobuf_response(StatusCode::OK, document.snapshot),
        (Ok(_), Ok(false)) => protocol_error(ServiceError::PermissionDenied),
        (Err(error), _) | (_, Err(error)) => protocol_error(error),
    }
}

/// Local-development-only identity adapter. Its values are converted to trusted
/// server inputs at the HTTP boundary and then overwrite the envelope actor.
fn dev_principal(headers: &HeaderMap) -> Result<TrustedPrincipal, ServiceError> {
    let tenant = headers
        .get("x-makefigma-dev-tenant-id")
        .and_then(|value| value.to_str().ok())
        .ok_or(ServiceError::PermissionDenied)?;
    let actor = headers
        .get("x-makefigma-dev-actor-id")
        .and_then(|value| value.to_str().ok())
        .ok_or(ServiceError::PermissionDenied)?;
    Ok(TrustedPrincipal {
        tenant_id: parse_id(tenant)?,
        actor_id: parse_id(actor)?,
    })
}

fn parse_id(value: &str) -> Result<Id, ServiceError> {
    let normalized = value.replace('-', "");
    if normalized.len() != 32 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ServiceError::InvalidEnvelope);
    }
    let mut id = [0; 16];
    for (index, pair) in normalized.as_bytes().chunks_exact(2).enumerate() {
        id[index] = u8::from_str_radix(
            std::str::from_utf8(pair).map_err(|_| ServiceError::InvalidEnvelope)?,
            16,
        )
        .map_err(|_| ServiceError::InvalidEnvelope)?;
    }
    Ok(id)
}

fn protocol_error(error: ServiceError) -> Response {
    protobuf_response(status_for(&error), error.protocol_error().encode_to_vec())
}
fn status_for(error: &ServiceError) -> StatusCode {
    match error {
        ServiceError::PermissionDenied => StatusCode::FORBIDDEN,
        ServiceError::MissingDocument => StatusCode::NOT_FOUND,
        ServiceError::BaseRevisionConflict { .. } | ServiceError::OperationIdConflict => {
            StatusCode::CONFLICT
        }
        ServiceError::ResourceLimit => StatusCode::PAYLOAD_TOO_LARGE,
        ServiceError::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    }
}
fn protobuf_response(status: StatusCode, body: Vec<u8>) -> Response {
    cors_response(status, body, PROTOBUF_CONTENT_TYPE)
}
fn plain_response(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response {
    cors_response(status, body, content_type)
}
fn cors_response(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response {
    let mut response = (status, body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).expect("constant content type"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:3000"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "content-type, x-makefigma-dev-tenant-id, x-makefigma-dev-actor-id",
        ),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    // Chromium may classify a loopback service on another port as a private
    // network target. This local-development-only adapter explicitly answers
    // that preflight; production gateways use their own origin policy.
    response.headers_mut().insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    response.headers_mut().insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    response
}

pub async fn serve(address: std::net::SocketAddr, state: ApiState) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, router(state)).await
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use makefigma_protocol::v1::{
        CreatePage, OperationAck, OperationEnvelope, PageRef, PositionId, ResolvedOperation,
        ResolvedOperationBatch,
    };
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    use super::*;

    fn id(value: u8) -> Id {
        [value; 16]
    }
    fn id_hex(value: u8) -> String {
        id(value).iter().map(|byte| format!("{byte:02x}")).collect()
    }
    fn app() -> Router {
        router(ApiState::new(
            DocumentService::in_memory(CoreOperationReducer::new(ENGINE_SEMANTICS_VERSION))
                .unwrap(),
        ))
    }
    fn durable_app(path: &std::path::Path) -> Router {
        router(ApiState::new(
            DocumentService::open(path, CoreOperationReducer::new(ENGINE_SEMANTICS_VERSION))
                .unwrap(),
        ))
    }
    fn headers(request: axum::http::request::Builder) -> axum::http::request::Builder {
        request
            .header("x-makefigma-dev-tenant-id", id_hex(2))
            .header("x-makefigma-dev-actor-id", id_hex(7))
    }
    fn payload() -> Vec<u8> {
        ResolvedOperationBatch {
            operations: vec![ResolvedOperation {
                kind: Some(
                    makefigma_protocol::v1::resolved_operation::Kind::CreatePage(CreatePage {
                        page: Some(PageRef {
                            page_id: id(3).to_vec(),
                            name: "Ideas".into(),
                            position_id: Some(PositionId {
                                key: id(3).to_vec(),
                                actor_id: [0; 16].to_vec(),
                            }),
                        }),
                    }),
                ),
            }],
        }
        .encode_to_vec()
    }
    fn envelope(payload: Vec<u8>) -> Vec<u8> {
        OperationEnvelope {
            schema_version: 1,
            document_id: id(1).to_vec(),
            operation_id: id(9).to_vec(),
            transaction_id: id(10).to_vec(),
            actor_id: id(99).to_vec(),
            session_id: id(11).to_vec(),
            client_sequence: 1,
            base_revision: 0,
            causal_parent_ids: vec![],
            payload_hash: Sha256::digest(&payload).to_vec(),
            payload,
            engine_semantics_version: Some(ENGINE_SEMANTICS_VERSION),
        }
        .encode_to_vec()
    }

    #[tokio::test]
    async fn protobuf_operation_is_durably_accepted_over_the_http_boundary() {
        let app = app();
        let create = headers(Request::post(format!("/v1/documents/{}", id_hex(1))))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(create).await.unwrap().status(),
            StatusCode::CREATED
        );
        let payload = payload();
        let request = headers(
            Request::post(format!("/v1/documents/{}/operations", id_hex(1)))
                .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE),
        )
        .body(Body::from(envelope(payload)))
        .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let ack = OperationAck::decode(body).unwrap();
        assert_eq!(ack.accepted_revision, Some(1));
        let denied = Request::get(format!("/v1/documents/{}/snapshot", id_hex(1)))
            .header("x-makefigma-dev-tenant-id", id_hex(2))
            .header("x-makefigma-dev-actor-id", id_hex(8))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(denied).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn durable_http_reopen_serves_the_accepted_snapshot_and_idempotent_replay() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("document-api.sqlite");
        let first = durable_app(&database);
        let create = headers(Request::post(format!("/v1/documents/{}", id_hex(1))))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            first.clone().oneshot(create).await.unwrap().status(),
            StatusCode::CREATED
        );
        let encoded_payload = payload();
        let encoded_envelope = envelope(encoded_payload);
        let submit = headers(
            Request::post(format!("/v1/documents/{}/operations", id_hex(1)))
                .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE),
        )
        .body(Body::from(encoded_envelope.clone()))
        .unwrap();
        assert_eq!(
            first.clone().oneshot(submit).await.unwrap().status(),
            StatusCode::OK
        );
        drop(first);

        let restarted = durable_app(&database);
        let snapshot = headers(Request::get(format!(
            "/v1/documents/{}/snapshot",
            id_hex(1)
        )))
        .body(Body::empty())
        .unwrap();
        let response = restarted.clone().oneshot(snapshot).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let restored = makefigma_document_codec::document_from_wire_snapshot(&body).unwrap();
        assert_eq!(restored.revision, 1);

        let replay = headers(
            Request::post(format!("/v1/documents/{}/operations", id_hex(1)))
                .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE),
        )
        .body(Body::from(encoded_envelope))
        .unwrap();
        let response = restarted.oneshot(replay).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            OperationAck::decode(body).unwrap().accepted_revision,
            Some(1)
        );
    }

    #[tokio::test]
    async fn rejects_cross_route_envelope_and_missing_development_principal() {
        let encoded_payload = payload();
        let mismatched = Request::post(format!("/v1/documents/{}/operations", id_hex(2)))
            .body(Body::from(envelope(encoded_payload)))
            .unwrap();
        let response = app().oneshot(mismatched).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let request = headers(Request::post(format!(
            "/v1/documents/{}/operations",
            id_hex(2)
        )))
        .body(Body::from(envelope(payload())))
        .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn creates_from_a_self_validating_canonical_snapshot() {
        let app = app();
        let document = Document::with_id(DocumentId(u128::from_be_bytes(id(1))));
        let snapshot =
            makefigma_document_codec::snapshot_from_document(&document, ENGINE_SEMANTICS_VERSION)
                .unwrap();
        let request = headers(Request::post(format!("/v1/documents/{}", id_hex(1))))
            .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)
            .body(Body::from(snapshot))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let retry = headers(Request::post(format!("/v1/documents/{}", id_hex(1))))
            .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)
            .body(Body::from(
                makefigma_document_codec::snapshot_from_document(
                    &document,
                    ENGINE_SEMANTICS_VERSION,
                )
                .unwrap(),
            ))
            .unwrap();
        assert_eq!(app.oneshot(retry).await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn exposes_cors_preflight_on_concrete_document_routes() {
        let request = Request::builder()
            .method("OPTIONS")
            .uri(format!("/v1/documents/{}", id_hex(1)))
            .header("origin", "http://127.0.0.1:3000")
            .body(Body::empty())
            .unwrap();
        let response = app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-private-network")
                .unwrap(),
            "true"
        );
        assert_eq!(
            response
                .headers()
                .get("cross-origin-resource-policy")
                .unwrap(),
            "cross-origin"
        );
    }

    #[tokio::test]
    async fn admits_request_bodies_above_axums_default_limit_for_service_validation() {
        let oversized_for_default = vec![0; 2 * 1024 * 1024 + 1];
        let create = headers(Request::post(format!("/v1/documents/{}", id_hex(1))))
            .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)
            .body(Body::from(oversized_for_default.clone()))
            .unwrap();
        assert_eq!(
            app().oneshot(create).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );

        let operation = headers(Request::post(format!(
            "/v1/documents/{}/operations",
            id_hex(1)
        )))
        .header(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)
        .body(Body::from(oversized_for_default))
        .unwrap();
        assert_eq!(
            app().oneshot(operation).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
}
