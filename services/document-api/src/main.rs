use std::{env, path::PathBuf};

use makefigma_document_api::{ApiState, ENGINE_SEMANTICS_VERSION, serve};
use makefigma_document_service::{DocumentService, core_snapshot_adapter::CoreOperationReducer};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = env::var("MAKEFIGMA_DOCUMENT_API_ADDRESS")
        .unwrap_or_else(|_| "127.0.0.1:8788".into())
        .parse()?;
    let database = env::var_os("MAKEFIGMA_DOCUMENT_API_DATABASE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".local/document-service.sqlite"));
    if let Some(parent) = database.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let service = DocumentService::open(
        database,
        CoreOperationReducer::new(ENGINE_SEMANTICS_VERSION),
    )
    .map_err(|error| {
        std::io::Error::other(format!("document service initialization failed: {error:?}"))
    })?;
    eprintln!("Makefigma Document API listening on http://{address}");
    serve(address, ApiState::new(service)).await?;
    Ok(())
}
