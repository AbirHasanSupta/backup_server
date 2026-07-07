perfectly works. now design the full android application with proper ui beautification, ui ux with modern 2026s standard and appealing and easy to use

features:
Android
1. users will be select folders on which backup will be working, which is currently implemented. enhance it
2. need options of file type: photos, videos, pdf and docs, others, All. user can choose multiple of them/all/others and only those type of files will be backed up
3. sync now is currently implemented. but need background schedular (if not implemented) which will be by default work on each 15 minute. but users will have to change the duration from 1 minute to 24 hour. and also they can pause auto sync and can only rely on the sync now button
4. when syncing, need notification of the progress of sync in the notification bar. after completing it will show complete in the notification bar
5. users can refresh the backup(for example, 5 files of a folder was backed up and now user wants to refresh the backup)
6. users should be able to connect with the server by discovering the servers on the same network. if multiple servers are found, users should be able to choose one of them.

Server:
1. a simple desktop application will be developed for the server
2. the server will be configured by the user(by default configuration will be set to as is now)
3. the server will be able to accept/reject connections from the android application when a user connects to the server from the android application.
4. when a user connects to the server from the android application, the server will display a notification that a new device has connected and will show the device name and IP address.
5. the server will have a simple UI to show the list of connected devices and their backup status, including the last backup time and the number of files backed up.
6. the server can remove the device from the connected devices list.


Android:
1. when pressing start scan: even if a server running on the same network, it shows no backup servers found on this network
2. if i manually enter the server ip address, it still in offline mode.
3. even after offline mode, if i press sync now, it shows 'backup failed. fetch failed. java.net.UnknownServiceException:CLEARTEXT communication to 192.168.10.104 not permitted by network security policy'
4. these are the issues of the preview build. but in development mode(build), scanning is not allowed. but saving a ip address sends a notification to the server and server can accept the request.
5. in development mode, saving ip makes the application online mode and sync now also works. background sync is not allowed in development mode expo build.