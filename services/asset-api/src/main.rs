use makefigma_asset_api::{ApiState, serve};
use makefigma_asset_service::AssetService;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let service = AssetService::open(".local/asset-service.sqlite")
        .expect("open local Asset Service database");
    let address = "127.0.0.1:8789".parse().expect("loopback address");
    eprintln!("Makefigma Asset API listening on http://{address}");
    serve(address, ApiState::new(service)).await
}
