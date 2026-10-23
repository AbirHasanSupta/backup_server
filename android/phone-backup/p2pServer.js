import { NativeModules, DeviceEventEmitter, Platform, Alert } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import {
  isP2PEnabled,
  getP2PPort,
  getLocalPeerIdentity,
  saveP2PFeedItem,
  savePairedPeer,
} from './p2pSettings';
import { showNewSharePostNotification } from './notificationService';

const P2PServerModule = NativeModules.PhoneBackupP2PServer;

let _isInitialized = false;
let _serverRunning = false;
let _activePort = 8088;

/**
 * Starts the embedded mobile P2P HTTP server daemon.
 */
export async function startP2PServer(customPort = null) {
  if (Platform.OS !== 'android' || !P2PServerModule?.startServer) {
    return { running: false, reason: 'P2P native server is only available on Android native builds.' };
  }

  try {
    const [enabled, port, identity] = await Promise.all([
      isP2PEnabled(),
      customPort || getP2PPort(),
      getLocalPeerIdentity(),
    ]);

    if (!enabled) {
      return { running: false, reason: 'P2P mode is disabled in settings.' };
    }

    const configJson = JSON.stringify({
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      username: identity.username,
    });

    const result = await P2PServerModule.startServer(port, configJson);
    _serverRunning = result?.running || false;
    _activePort = result?.port || port;

    DeviceEventEmitter.emit('p2p-server-status', {
      running: _serverRunning,
      port: _activePort,
      deviceId: identity.deviceId,
    });

    return result;
  } catch (err) {
    console.warn('[P2PServer] Failed to start server daemon:', err?.message);
    return { running: false, error: err?.message };
  }
}

/**
 * Stops the embedded P2P server daemon.
 */
export async function stopP2PServer() {
  if (Platform.OS !== 'android' || !P2PServerModule?.stopServer) {
    return false;
  }

  try {
    await P2PServerModule.stopServer();
    _serverRunning = false;
    DeviceEventEmitter.emit('p2p-server-status', { running: false, port: _activePort });
    return true;
  } catch (err) {
    console.warn('[P2PServer] Failed to stop server daemon:', err?.message);
    return false;
  }
}

/**
 * Queries current daemon status from native layer.
 */
export async function getP2PServerStatus() {
  if (Platform.OS !== 'android' || !P2PServerModule?.getServerStatus) {
    return { running: false, port: _activePort };
  }

  try {
    const status = await P2PServerModule.getServerStatus();
    _serverRunning = status?.running || false;
    if (status?.port) _activePort = status.port;
    return status;
  } catch (err) {
    return { running: false, port: _activePort, error: err?.message };
  }
}

/**
 * Initializes listeners for incoming P2P events from the native Android HTTP server.
 */
export function initializeP2PServer() {
  if (_isInitialized) return;
  _isInitialized = true;

  // 1. Listen for incoming direct shares from peers
  DeviceEventEmitter.addListener('p2p_incoming_share', async (data) => {
    try {
      let parsedFiles = [];
      if (data.filesJson) {
        try {
          parsedFiles = JSON.parse(data.filesJson);
        } catch {}
      }

      const feedPost = {
        id: data.shareId,
        shared_by_device_id: data.sharedByDeviceId,
        shared_by_device_name: data.sharedByDeviceName || 'Peer',
        shared_by_username: data.sharedByUsername || '',
        caption: data.caption || '',
        post_kind: data.postKind || 'direct_post',
        created_at: Number(data.createdAt) || Date.now(),
        files: parsedFiles,
        is_p2p: true,
      };

      await saveP2PFeedItem(feedPost);

      // Automatically save to device Media Library (gallery) so user can view offline
      // and background sync will archive it to the desktop server once connected
      for (const file of parsedFiles) {
        if (file.uri) {
          MediaLibrary.saveToLibraryAsync(file.uri).catch(() => {});
        }
      }

      // Alert UI listeners that a new P2P share was received
      DeviceEventEmitter.emit('p2p-share-received', feedPost);
      DeviceEventEmitter.emit('feed_updated', feedPost);

      // Trigger standard system push notification
      showNewSharePostNotification({
        id: feedPost.id,
        shared_by_name: feedPost.shared_by_username || feedPost.shared_by_device_name,
        caption: feedPost.caption,
        files_count: parsedFiles.length,
      }).catch(() => {});
    } catch (err) {
      console.warn('[P2PServer] Error handling incoming P2P share:', err);
    }
  });

  // 2. Listen for incoming pairing requests
  DeviceEventEmitter.addListener('p2p_pair_request', (data) => {
    DeviceEventEmitter.emit('p2p-pair-requested', data);

    const displayName = data.username ? `${data.username} (${data.deviceName})` : data.deviceName || 'Nearby Device';
    Alert.alert(
      'Nearby Device Pairing Request',
      `"${displayName}" wants to pair with your phone for direct Wi-Fi transfers.\n\nVerification PIN: ${data.pin}`,
      [
        {
          text: 'Reject',
          style: 'cancel',
        },
        {
          text: 'Accept & Pair',
          onPress: async () => {
            try {
              await savePairedPeer({
                peerId: data.deviceId,
                deviceName: data.deviceName || 'Nearby Peer',
                username: data.username || '',
                ip: data.ip || '',
                port: data.port || 8088,
                pairedAt: Date.now(),
                lastSeen: Date.now(),
              });
              showNewSharePostNotification({
                id: 'p2p_paired_' + Date.now(),
                shared_by_name: displayName,
                caption: 'Device successfully paired for direct Wi-Fi transfers!',
                files_count: 0,
              }).catch(() => {});
            } catch (err) {
              console.warn('[P2PServer] Failed to save paired peer:', err);
            }
          },
        },
      ]
    );
  });

  // Automatically start daemon if P2P mode is enabled
  isP2PEnabled().then((enabled) => {
    if (enabled) {
      startP2PServer().catch(() => {});
    }
  });
}
