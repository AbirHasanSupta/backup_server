

1. the server and the android app should be always synced
2. if already a folder is synced but deleted from the pc app, when sync again, the deleted folder/deleted files of that folder should be synced again. only those, not all files again
3. should maintain metadata of the files for this purpose.
4. The key idea is: never compare files by filename or modification time alone. Instead, maintain a database of what has already been backed up.
5. Phone sends metadata for all 10 photos. PC database is empty. Phone uploads all 10. Database now contains 10 entries. User deletes two files on PC. Database still has records for all 10, but two files are missing.Next backup Phone again scans. Phone sends metadata only.
For each photo: if database entry exists
    if file exists
        skip

    else
        request upload

else
    request upload
Need:
IMG009
IMG010
Phone uploads only those two.
Nothing else is transferred.
Metadata to send
Each photo should have something like
{
    "id": "media_store_id",
    "size": 5234412,
    "modified": 1719981111,
    "sha256": "...",
    "filename": "IMG_1234.jpg"
}
The SHA-256 hash uniquely identifies the file content. You can optimize by sending the hash only when needed because hashing large files on the phone is relatively expensive.

sync algorithm:
Phone scans files

↓

Phone sends metadata

↓

PC checks database

↓

Need Upload?
    Yes → request file
    No  → skip

↓

Phone uploads only requested files

↓

PC stores file

↓

Update database


Why this works
No overwriting existing files.
Deleted files on the PC are restored automatically.
New photos are uploaded.
Existing photos are skipped.
Only missing or changed files are transferred, making backups fast.

This is essentially the same high-level approach used by backup systems like cloud photo backup services: metadata comparison first, file transfer only when the server determines it's necessary.


this is simple explanation of the algorithm. implement the fully production ready architecture. change/enhance the backend/android according too it