//! Loopback HTTP adapter for the durable Phase 1 Asset Service.
//!
//! The adapter is deliberately narrow: it exposes resumable admission and
//! document-scoped delivery without handing clients the SQLite/object-store
//! implementation. Identity headers are local-development-only.

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, options, post, put},
};
use makefigma_asset_service::{
    AssetKind, AssetService, AssetServiceError, Id, TrustedPrincipal, UploadRequest,
};
use serde::{Deserialize, Serialize};

const JSON: &str = "application/json; charset=utf-8";

#[derive(Clone)]
pub struct ApiState {
    service: Arc<AssetService>,
}

impl ApiState {
    pub fn new(service: AssetService) -> Self {
        Self::from_shared(Arc::new(service))
    }

    /// Lets the process-level maintenance task and the HTTP adapter share the
    /// same durable service without exposing its storage implementation to
    /// individual routes.
    pub fn from_shared(service: Arc<AssetService>) -> Self {
        Self {
            service,
        }
    }
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/v1/assets/uploads/{session_id}",
            post(begin_upload).get(upload_progress).options(preflight),
        )
        .route(
            "/v1/assets/uploads/{session_id}/chunks/{offset}",
            put(append_chunk).options(preflight),
        )
        .route(
            "/v1/assets/uploads/{session_id}/complete",
            post(complete_upload).options(preflight),
        )
        .route("/v1/assets/audit-events", get(audit_events).options(preflight))
        .route(
            "/v1/documents/{document_id}/writers",
            put(grant_writer).options(preflight),
        )
        .route(
            "/v1/documents/{document_id}/assets/{asset_id}",
            put(attach_asset).options(preflight),
        )
        .route(
            "/v1/documents/{document_id}/assets/{asset_id}/download-grants",
            post(issue_download_grant).options(preflight),
        )
        .route(
            "/v1/assets/downloads/{token}",
            get(download_asset).options(preflight),
        )
        .route("/{*path}", options(preflight))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(state)
}

async fn health() -> Response {
    json_response(
        StatusCode::OK,
        b"{\"status\":\"ok\",\"service\":\"makefigma-asset-api\",\"protocolVersion\":1}".to_vec(),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginUploadBody {
    kind: String,
    content_hash: String,
    media_type: String,
    byte_length: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadStatusBody {
    session_id: String,
    accepted_byte_length: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetBody {
    asset_id: String,
    content_hash: String,
    kind: &'static str,
    media_type: String,
    byte_length: usize,
    deduplicated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantBody {
    lifetime_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantResponse {
    token: String,
    expires_at_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditEventsQuery {
    after_sequence: Option<i64>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEventBody {
    sequence: i64,
    document_id: Option<String>,
    asset_id: Option<String>,
    action: String,
    outcome: String,
    at_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEventsResponse {
    events: Vec<AuditEventBody>,
    next_sequence: i64,
}

async fn begin_upload(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<BeginUploadBody>,
) -> Response {
    let (principal, session_id) = match (principal(&headers), parse_id(&session_id)) {
        (Ok(principal), Ok(session_id)) => (principal, session_id),
        (Err(error), _) | (_, Err(error)) => return error_response(error),
    };
    let kind = match body.kind.as_str() {
        "raster-image" => AssetKind::RasterImage,
        "font" => AssetKind::Font,
        _ => return error_response(AssetServiceError::InvalidRequest),
    };
    let content_hash = match parse_hash(&body.content_hash) {
        Ok(hash) => hash,
        Err(error) => return error_response(error),
    };
    match state.service.begin_upload(
        principal,
        UploadRequest {
            session_id,
            kind,
            expected_content_hash: content_hash,
            declared_media_type: body.media_type,
            expected_byte_length: body.byte_length,
        },
    ) {
        Ok(session) => json_value(
            StatusCode::CREATED,
            UploadStatusBody {
                session_id: hex(&session.session_id),
                accepted_byte_length: session.accepted_byte_length,
            },
        ),
        Err(error) => error_response(error),
    }
}

async fn upload_progress(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (principal, session_id) = match (principal(&headers), parse_id(&session_id)) {
        (Ok(principal), Ok(session_id)) => (principal, session_id),
        (Err(error), _) | (_, Err(error)) => return error_response(error),
    };
    match state.service.upload_progress(principal, session_id) {
        Ok(session) => json_value(
            StatusCode::OK,
            UploadStatusBody {
                session_id: hex(&session.session_id),
                accepted_byte_length: session.accepted_byte_length,
            },
        ),
        Err(error) => error_response(error),
    }
}

async fn append_chunk(
    State(state): State<ApiState>,
    Path((session_id, offset)): Path<(String, usize)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (principal, session_id) = match (principal(&headers), parse_id(&session_id)) {
        (Ok(principal), Ok(session_id)) => (principal, session_id),
        (Err(error), _) | (_, Err(error)) => return error_response(error),
    };
    match state
        .service
        .append_chunk(principal, session_id, offset, body.as_ref())
    {
        Ok(session) => json_value(
            StatusCode::OK,
            UploadStatusBody {
                session_id: hex(&session.session_id),
                accepted_byte_length: session.accepted_byte_length,
            },
        ),
        Err(error) => error_response(error),
    }
}

async fn complete_upload(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (principal, session_id) = match (principal(&headers), parse_id(&session_id)) {
        (Ok(principal), Ok(session_id)) => (principal, session_id),
        (Err(error), _) | (_, Err(error)) => return error_response(error),
    };
    match state.service.complete_upload(principal, session_id) {
        Ok(completed) => json_value(
            StatusCode::OK,
            AssetBody {
                asset_id: hex(&completed.asset.asset_id),
                content_hash: hex(&completed.asset.content_hash),
                kind: kind_name(completed.asset.kind),
                media_type: completed.asset.media_type,
                byte_length: completed.asset.byte_length,
                deduplicated: completed.deduplicated,
            },
        ),
        Err(error) => error_response(error),
    }
}

async fn audit_events(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<AuditEventsQuery>,
) -> Response {
    let principal = match principal(&headers) {
        Ok(principal) => principal,
        Err(error) => return error_response(error),
    };
    let after_sequence = query.after_sequence.unwrap_or(0).max(0);
    let events = match state.service.audit_events_page(
        principal,
        after_sequence,
        query.limit.unwrap_or(100),
    ) {
        Ok(events) => events,
        Err(error) => return error_response(error),
    };
    let next_sequence = events
        .last()
        .map(|event| event.sequence)
        .unwrap_or(after_sequence);
    json_value(
        StatusCode::OK,
        AuditEventsResponse {
            events: events
                .into_iter()
                .map(|event| AuditEventBody {
                    sequence: event.sequence,
                    document_id: event.document_id.map(|id| hex(&id)),
                    asset_id: event.asset_id.map(|id| hex(&id)),
                    action: event.action,
                    outcome: event.outcome,
                    at_seconds: event.at_seconds,
                })
                .collect(),
            next_sequence,
        },
    )
}

async fn grant_writer(
    State(state): State<ApiState>,
    Path(document_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (principal, document_id) = match (principal(&headers), parse_id(&document_id)) {
        (Ok(principal), Ok(document_id)) => (principal, document_id),
        (Err(error), _) | (_, Err(error)) => return error_response(error),
    };
    match state
        .service
        .grant_document_writer(principal.tenant_id, document_id, principal.actor_id)
    {
        Ok(()) => empty_response(StatusCode::NO_CONTENT),
        Err(error) => error_response(error),
    }
}

async fn attach_asset(
    State(state): State<ApiState>,
    Path((document_id, asset_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let (principal, document_id, asset_id) = match (
        principal(&headers),
        parse_id(&document_id),
        parse_id(&asset_id),
    ) {
        (Ok(principal), Ok(document_id), Ok(asset_id)) => (principal, document_id, asset_id),
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            return error_response(error);
        }
    };
    match state
        .service
        .attach_asset_to_document(principal, document_id, asset_id)
    {
        Ok(()) => empty_response(StatusCode::NO_CONTENT),
        Err(error) => error_response(error),
    }
}

async fn issue_download_grant(
    State(state): State<ApiState>,
    Path((document_id, asset_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<GrantBody>,
) -> Response {
    let (principal, document_id, asset_id) = match (
        principal(&headers),
        parse_id(&document_id),
        parse_id(&asset_id),
    ) {
        (Ok(principal), Ok(document_id), Ok(asset_id)) => (principal, document_id, asset_id),
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            return error_response(error);
        }
    };
    match state.service.issue_download_grant(
        principal,
        document_id,
        asset_id,
        unix_seconds(),
        body.lifetime_seconds,
    ) {
        Ok(grant) => json_value(
            StatusCode::CREATED,
            GrantResponse {
                token: hex(&grant.token),
                expires_at_seconds: grant.expires_at_seconds,
            },
        ),
        Err(error) => error_response(error),
    }
}

async fn download_asset(
    State(state): State<ApiState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (principal, token) = match (principal(&headers), parse_hash(&token)) {
        (Ok(principal), Ok(token)) => (principal, token),
        (Err(error), _) | (_, Err(error)) => return error_response(error),
    };
    match state
        .service
        .download_with_token(principal, token, unix_seconds())
    {
        Ok((asset, bytes)) => binary_response(StatusCode::OK, bytes, &asset.media_type),
        Err(error) => error_response(error),
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn principal(headers: &HeaderMap) -> Result<TrustedPrincipal, AssetServiceError> {
    let tenant = headers
        .get("x-makefigma-dev-tenant-id")
        .and_then(|value| value.to_str().ok())
        .ok_or(AssetServiceError::PermissionDenied)?;
    let actor = headers
        .get("x-makefigma-dev-actor-id")
        .and_then(|value| value.to_str().ok())
        .ok_or(AssetServiceError::PermissionDenied)?;
    Ok(TrustedPrincipal {
        tenant_id: parse_id(tenant)?,
        actor_id: parse_id(actor)?,
    })
}

fn parse_id(value: &str) -> Result<Id, AssetServiceError> {
    let bytes = decode_hex(value)?;
    bytes
        .try_into()
        .map_err(|_| AssetServiceError::InvalidRequest)
}
fn parse_hash(value: &str) -> Result<[u8; 32], AssetServiceError> {
    let bytes = decode_hex(value)?;
    bytes
        .try_into()
        .map_err(|_| AssetServiceError::InvalidRequest)
}
fn decode_hex(value: &str) -> Result<Vec<u8>, AssetServiceError> {
    let normalized = value.replace('-', "");
    if normalized.len() % 2 != 0 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AssetServiceError::InvalidRequest);
    }
    normalized
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(
                std::str::from_utf8(pair).map_err(|_| AssetServiceError::InvalidRequest)?,
                16,
            )
            .map_err(|_| AssetServiceError::InvalidRequest)
        })
        .collect()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn kind_name(kind: AssetKind) -> &'static str {
    match kind {
        AssetKind::RasterImage => "raster-image",
        AssetKind::Font => "font",
    }
}
fn error_response(error: AssetServiceError) -> Response {
    json_response(
        status_for(&error),
        format!("{{\"code\":\"{}\"}}", error_code(&error)).into_bytes(),
    )
}
fn error_code(error: &AssetServiceError) -> &'static str {
    match error {
        AssetServiceError::PermissionDenied => "PERMISSION_DENIED",
        AssetServiceError::SessionMissing
        | AssetServiceError::AssetMissing
        | AssetServiceError::GrantMissingOrExpired => "NOT_FOUND",
        AssetServiceError::UploadOffsetConflict { .. } => "OFFSET_CONFLICT",
        AssetServiceError::ResourceLimit => "RESOURCE_LIMIT",
        AssetServiceError::ContentHashMismatch => "CONTENT_HASH_MISMATCH",
        AssetServiceError::MimeMismatch => "MIME_MISMATCH",
        AssetServiceError::FontInvalid => "FONT_INVALID",
        AssetServiceError::Storage => "STORAGE",
        AssetServiceError::InvalidRequest => "INVALID_REQUEST",
    }
}
fn status_for(error: &AssetServiceError) -> StatusCode {
    match error {
        AssetServiceError::PermissionDenied => StatusCode::FORBIDDEN,
        AssetServiceError::SessionMissing
        | AssetServiceError::AssetMissing
        | AssetServiceError::GrantMissingOrExpired => StatusCode::NOT_FOUND,
        AssetServiceError::UploadOffsetConflict { .. } => StatusCode::CONFLICT,
        AssetServiceError::ResourceLimit => StatusCode::PAYLOAD_TOO_LARGE,
        AssetServiceError::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    }
}
async fn preflight() -> Response {
    empty_response(StatusCode::NO_CONTENT)
}
fn json_value<T: Serialize>(status: StatusCode, value: T) -> Response {
    json_response(status, serde_json::to_vec(&value).expect("JSON response"))
}
fn json_response(status: StatusCode, body: Vec<u8>) -> Response {
    response_with(status, body, JSON)
}
fn binary_response(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response {
    response_with(status, body, content_type)
}
fn empty_response(status: StatusCode) -> Response {
    response_with(status, Vec::new(), JSON)
}
fn response_with(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).unwrap_or_else(|_| HeaderValue::from_static(JSON)),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("http://127.0.0.1:3000"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "content-type, x-makefigma-dev-tenant-id, x-makefigma-dev-actor-id",
        ),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, OPTIONS"),
    );
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    headers.insert(
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
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    use super::*;

    fn id(value: u8) -> Id {
        [value; 16]
    }
    fn id_hex(value: u8) -> String {
        hex(&id(value))
    }
    fn app() -> Router {
        router(ApiState::new(AssetService::in_memory().unwrap()))
    }
    fn durable_app(path: &std::path::Path) -> Router {
        router(ApiState::new(AssetService::open(path).unwrap()))
    }
    fn headers(request: axum::http::request::Builder) -> axum::http::request::Builder {
        request
            .header("x-makefigma-dev-tenant-id", id_hex(2))
            .header("x-makefigma-dev-actor-id", id_hex(7))
    }

    #[tokio::test]
    async fn admits_resumable_content_then_delivers_only_through_a_document_grant() {
        let app = app();
        let bytes = b"\x89PNG\r\n\x1a\nasset";
        let content_hash = hex(&Sha256::digest(bytes));
        let session = id_hex(1);
        let begin = headers(Request::post(format!("/v1/assets/uploads/{session}")))
            .header(header::CONTENT_TYPE, JSON)
            .body(Body::from(format!("{{\"kind\":\"raster-image\",\"contentHash\":\"{content_hash}\",\"mediaType\":\"image/png\",\"byteLength\":{}}}", bytes.len())))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(begin).await.unwrap().status(),
            StatusCode::CREATED
        );
        let append = headers(Request::put(format!(
            "/v1/assets/uploads/{session}/chunks/0"
        )))
        .body(Body::from(bytes.as_slice()))
        .unwrap();
        assert_eq!(
            app.clone().oneshot(append).await.unwrap().status(),
            StatusCode::OK
        );
        let complete = headers(Request::post(format!(
            "/v1/assets/uploads/{session}/complete"
        )))
        .body(Body::empty())
        .unwrap();
        let complete = app.clone().oneshot(complete).await.unwrap();
        assert_eq!(complete.status(), StatusCode::OK);
        let body = axum::body::to_bytes(complete.into_body(), usize::MAX)
            .await
            .unwrap();
        let asset_id = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["assetId"]
            .as_str()
            .unwrap()
            .to_owned();

        let document = id_hex(3);
        let writer = headers(Request::put(format!("/v1/documents/{document}/writers")))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(writer).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let attach = headers(Request::put(format!(
            "/v1/documents/{document}/assets/{asset_id}"
        )))
        .body(Body::empty())
        .unwrap();
        assert_eq!(
            app.clone().oneshot(attach).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );

        let issued_after = unix_seconds();
        let grant = headers(Request::post(format!(
            "/v1/documents/{document}/assets/{asset_id}/download-grants"
        )))
        .header(header::CONTENT_TYPE, JSON)
        // Unknown legacy/client clock fields must not influence server expiry.
        .body(Body::from(
            "{\"lifetimeSeconds\":60,\"nowSeconds\":18446744073709500000}",
        ))
        .unwrap();
        let grant = app.clone().oneshot(grant).await.unwrap();
        assert_eq!(grant.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(grant.into_body(), usize::MAX)
            .await
            .unwrap();
        let grant_body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        let expires_at = grant_body["expiresAtSeconds"].as_u64().unwrap();
        assert!(expires_at >= issued_after + 60);
        assert!(expires_at <= unix_seconds() + 60);
        let token = grant_body["token"].as_str().unwrap().to_owned();
        let download = headers(Request::get(format!("/v1/assets/downloads/{token}")))
            .body(Body::empty())
            .unwrap();
        let download = app.oneshot(download).await.unwrap();
        assert_eq!(download.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(download.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
    }

    #[tokio::test]
    async fn returns_tenant_scoped_incremental_audit_metadata() {
        let app = app();
        let bytes = b"\x89PNG\r\n\x1a\naudit";
        let content_hash = hex(&Sha256::digest(bytes));
        let session = id_hex(1);
        let begin = headers(Request::post(format!("/v1/assets/uploads/{session}")))
            .header(header::CONTENT_TYPE, JSON)
            .body(Body::from(format!("{{\"kind\":\"raster-image\",\"contentHash\":\"{content_hash}\",\"mediaType\":\"image/png\",\"byteLength\":{}}}", bytes.len())))
            .unwrap();
        assert_eq!(app.clone().oneshot(begin).await.unwrap().status(), StatusCode::CREATED);

        let page = headers(Request::get("/v1/assets/audit-events?afterSequence=0&limit=1"))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(page).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        assert_eq!(payload["events"].as_array().unwrap().len(), 1);
        assert_eq!(payload["events"][0]["action"], "upload_started");
        assert_eq!(payload["events"][0]["outcome"], "accepted");
        let next_sequence = payload["nextSequence"].as_i64().unwrap();
        assert!(next_sequence > 0);
        assert!(!String::from_utf8_lossy(&body).contains(&session));

        let empty = headers(Request::get(format!("/v1/assets/audit-events?afterSequence={next_sequence}")))
            .body(Body::empty())
            .unwrap();
        let empty = app.oneshot(empty).await.unwrap();
        let empty = serde_json::from_slice::<serde_json::Value>(&axum::body::to_bytes(empty.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert!(empty["events"].as_array().unwrap().is_empty());
        assert_eq!(empty["nextSequence"], next_sequence);
    }

    #[tokio::test]
    async fn durable_http_reopen_retains_attached_asset_delivery() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("asset-api.sqlite");
        let first = durable_app(&database);
        let bytes = b"\x89PNG\r\n\x1a\npersistent";
        let content_hash = hex(&Sha256::digest(bytes));
        let session = id_hex(1);
        let begin = headers(Request::post(format!("/v1/assets/uploads/{session}")))
            .header(header::CONTENT_TYPE, JSON)
            .body(Body::from(format!("{{\"kind\":\"raster-image\",\"contentHash\":\"{content_hash}\",\"mediaType\":\"image/png\",\"byteLength\":{}}}", bytes.len())))
            .unwrap();
        assert_eq!(
            first.clone().oneshot(begin).await.unwrap().status(),
            StatusCode::CREATED
        );
        let append = headers(Request::put(format!(
            "/v1/assets/uploads/{session}/chunks/0"
        )))
        .body(Body::from(bytes.as_slice()))
        .unwrap();
        assert_eq!(
            first.clone().oneshot(append).await.unwrap().status(),
            StatusCode::OK
        );
        let complete = headers(Request::post(format!(
            "/v1/assets/uploads/{session}/complete"
        )))
        .body(Body::empty())
        .unwrap();
        let complete = first.clone().oneshot(complete).await.unwrap();
        let asset_id = serde_json::from_slice::<serde_json::Value>(
            &axum::body::to_bytes(complete.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap()["assetId"]
            .as_str()
            .unwrap()
            .to_owned();
        let document = id_hex(3);
        let writer = headers(Request::put(format!("/v1/documents/{document}/writers")))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            first.clone().oneshot(writer).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let attach = headers(Request::put(format!(
            "/v1/documents/{document}/assets/{asset_id}"
        )))
        .body(Body::empty())
        .unwrap();
        assert_eq!(
            first.clone().oneshot(attach).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        drop(first);

        let restarted = durable_app(&database);
        let grant = headers(Request::post(format!(
            "/v1/documents/{document}/assets/{asset_id}/download-grants"
        )))
        .header(header::CONTENT_TYPE, JSON)
        .body(Body::from("{\"lifetimeSeconds\":60}"))
        .unwrap();
        let grant = restarted.clone().oneshot(grant).await.unwrap();
        assert_eq!(grant.status(), StatusCode::CREATED);
        let token = serde_json::from_slice::<serde_json::Value>(
            &axum::body::to_bytes(grant.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let download = headers(Request::get(format!("/v1/assets/downloads/{token}")))
            .body(Body::empty())
            .unwrap();
        let download = restarted.oneshot(download).await.unwrap();
        assert_eq!(download.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(download.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
    }
}
