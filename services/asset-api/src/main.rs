use std::{env, path::PathBuf, sync::Arc, time::Duration};

use makefigma_asset_api::{ApiState, serve};
use makefigma_asset_service::AssetService;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let address = env::var("MAKEFIGMA_ASSET_API_ADDRESS")
        .unwrap_or_else(|_| "127.0.0.1:8789".into())
        .parse()
        .map_err(std::io::Error::other)?;
    let database = env::var_os("MAKEFIGMA_ASSET_API_DATABASE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".local/asset-service.sqlite"));
    if let Some(parent) = database.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let service =
        Arc::new(AssetService::open(database).expect("open local Asset Service database"));
    spawn_maintenance(Arc::clone(&service), maintenance_configuration());
    eprintln!("Makefigma Asset API listening on http://{address}");
    serve(address, ApiState::from_shared(service)).await
}

#[derive(Debug, Clone, Copy)]
struct MaintenanceConfiguration {
    interval_seconds: u64,
    max_upload_age_seconds: u64,
    max_unattached_asset_age_seconds: u64,
}

fn maintenance_configuration() -> MaintenanceConfiguration {
    MaintenanceConfiguration {
        interval_seconds: positive_seconds("MAKEFIGMA_ASSET_MAINTENANCE_INTERVAL_SECONDS", 60 * 60),
        max_upload_age_seconds: positive_seconds(
            "MAKEFIGMA_ASSET_MAX_UPLOAD_AGE_SECONDS",
            24 * 60 * 60,
        ),
        max_unattached_asset_age_seconds: positive_seconds(
            "MAKEFIGMA_ASSET_MAX_UNATTACHED_ASSET_AGE_SECONDS",
            7 * 24 * 60 * 60,
        ),
    }
}

fn positive_seconds(name: &str, default: u64) -> u64 {
    positive_seconds_value(env::var(name).ok().as_deref(), default)
}

fn positive_seconds_value(value: Option<&str>, default: u64) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn spawn_maintenance(service: Arc<AssetService>, configuration: MaintenanceConfiguration) {
    tokio::spawn(async move {
        loop {
            let maintenance_service = Arc::clone(&service);
            let outcome = tokio::task::spawn_blocking(move || {
                maintenance_service.run_maintenance(
                    unix_seconds(),
                    configuration.max_upload_age_seconds,
                    configuration.max_unattached_asset_age_seconds,
                )
            })
            .await;
            match outcome {
                Ok(Ok(report)) => eprintln!(
                    "Asset maintenance: expired grants={}, abandoned uploads={}, queued objects={}, deleted objects={}",
                    report.expired_grants,
                    report.abandoned_uploads,
                    report.queued_orphaned_objects,
                    report.deleted_orphaned_objects,
                ),
                Ok(Err(_)) => eprintln!(
                    "Asset maintenance failed; will retry without interrupting HTTP service"
                ),
                Err(_) => eprintln!(
                    "Asset maintenance worker stopped; will retry without interrupting HTTP service"
                ),
            }
            tokio::time::sleep(Duration::from_secs(configuration.interval_seconds)).await;
        }
    });
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::positive_seconds_value;

    #[test]
    fn maintenance_durations_ignore_missing_invalid_and_zero_values() {
        assert_eq!(positive_seconds_value(None, 10), 10);
        assert_eq!(positive_seconds_value(Some("invalid"), 10), 10);
        assert_eq!(positive_seconds_value(Some("0"), 10), 10);
        assert_eq!(positive_seconds_value(Some("15"), 10), 15);
    }
}
