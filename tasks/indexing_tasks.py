"""tasks/indexing_tasks.py — Distributed Media Indexing & Trip Clustering Tasks."""

import logging
from celery_app import celery_app

logger = logging.getLogger("backup_server.tasks.indexing")


@celery_app.task(
    name="tasks.indexing_tasks.run_trip_clustering",
    time_limit=300,
    soft_time_limit=240,
)
def run_trip_clustering(source_id: str | None = None):
    """Run spatial-temporal clustering and reverse-geocoding in the background."""
    from trips import cluster_source_media, cluster_all_devices
    try:
        if source_id:
            clusters = cluster_source_media(source_id)
            logger.info("Clustered %s trips for source %s", len(clusters), source_id)
            return {"source_id": source_id, "clusters_count": len(clusters)}
        else:
            cluster_all_devices()
            return {"status": "all_clustered"}
    except Exception as exc:
        logger.error("Trip clustering task failed: %s", exc)
        return {"status": "failed", "error": str(exc)}
