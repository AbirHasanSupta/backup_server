"""core/exceptions.py — Domain and API Exception Taxonomy."""

from fastapi import HTTPException, status


class BackupServerError(Exception):
    """Base exception for all backup server domain errors."""
    pass


class StorageError(BackupServerError):
    """File storage or I/O error."""
    pass


class StoragePathTraversalError(StorageError):
    """Invalid relative path attempting directory traversal."""
    pass


class DeviceNotFoundError(BackupServerError):
    """Specified device_id does not exist."""
    pass


class DeviceUnauthorizedError(BackupServerError):
    """Device token or API key is invalid."""
    pass


class ShareAccessDeniedError(BackupServerError):
    """Access to a shared post, reel, or folder was denied."""
    pass
