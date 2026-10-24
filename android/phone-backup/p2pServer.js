import { NativeModules, DeviceEventEmitter, Platform, Alert } from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  isP2PEnabled,
  getP2PPort,
  getLocalPeerIdentity,
  saveP2PFeedItem,
  savePairedPeer,
  getLocalP2PFeed,
} from './p2pSettings';
import { showNewSharePostNotification, showDevicePairedNotification } from './notificationService';
import { notifyPairAccepted } from './p2pClient';

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
 * Synchronizes the local JavaScript P2P feed manifest with the native HTTP server.
 * This ensures peers requesting GET /p2p/feed receive the full list of shared media.
 */
export async function syncFeedManifest(feedItems = null) {
  if (Platform.OS !== 'android' || !P2PServerModule?.updateFeedManifest) return;
  try {
    const feed = feedItems || (await getLocalP2PFeed());
    const payload = JSON.stringify({ items: feed || [], status: 'ok' });
    await P2PServerModule.updateFeedManifest(payload);
  } catch (err) {
    console.warn('[P2PServer] syncFeedManifest error:', err?.message);
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
      syncFeedManifest().catch(() => {});

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

  let _activePairingPin = null;

  // 2. Listen for incoming pairing requests
  DeviceEventEmitter.addListener('p2p_pair_request', (data) => {
    DeviceEventEmitter.emit('p2p-pair-requested', data);

    // Suppress duplicate popup for the same PIN / peer if already showing
    const activeKey = data.pin || data.deviceId;
    if (_activePairingPin && _activePairingPin === activeKey) {
      return;
    }
    _activePairingPin = activeKey;
    setTimeout(() => {
      if (_activePairingPin === activeKey) _activePairingPin = null;
    }, 60_000);

    const displayName = data.username ? `${data.username} (${data.deviceName})` : data.deviceName || 'Nearby Device';
    Alert.alert(
      'Nearby Device Pairing Request',
      `"${displayName}" wants to pair with your phone for direct Wi-Fi transfers.\n\nVerification PIN: ${data.pin}`,
      [
        {
          text: 'Reject',
          style: 'cancel',
          onPress: () => {
            _activePairingPin = null;
          },
        },
        {
          text: 'Accept & Pair',
          onPress: async () => {
            _activePairingPin = null;
            try {
              const peerToSave = {
                peerId: data.deviceId,
                deviceName: data.deviceName || 'Nearby Peer',
                username: data.username || '',
                ip: data.ip || '',
                port: data.port || 8088,
                pairedAt: Date.now(),
                lastSeen: Date.now(),
              };
              await savePairedPeer(peerToSave);

              // Bidirectional mutual pairing: notify requesting peer so they automatically pair too
              const localIdentity = await getLocalPeerIdentity();
              if (data.ip) {
                notifyPairAccepted(data.ip, data.port || 8088, localIdentity, data.pin).catch(() => {});
              }

              showDevicePairedNotification(displayName).catch(() => {});
              DeviceEventEmitter.emit('p2p-peer-paired', peerToSave);
              DeviceEventEmitter.emit('p2p-peers-updated');
            } catch (err) {
              console.warn('[P2PServer] Failed to save paired peer:', err);
            }
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          _activePairingPin = null;
        },
      }
    );
  });

  // 3. Listen for pairing accepted callbacks from peers (mutual pairing)
  DeviceEventEmitter.addListener('p2p_pair_accepted', async (data) => {
    try {
      const displayName = data.username ? `${data.username} (${data.deviceName})` : data.deviceName || 'Nearby Device';
      const peerToSave = {
        peerId: data.deviceId,
        deviceName: data.deviceName || 'Nearby Peer',
        username: data.username || '',
        ip: data.ip || '',
        port: data.port || 8088,
        pairedAt: Date.now(),
        lastSeen: Date.now(),
      };
      await savePairedPeer(peerToSave);
      showDevicePairedNotification(displayName).catch(() => {});
      DeviceEventEmitter.emit('p2p-peer-paired', peerToSave);
      DeviceEventEmitter.emit('p2p-peers-updated');
    } catch (err) {
      console.warn('[P2PServer] Failed to save accepted peer:', err);
    }
  });

  // 4. Listen for incoming direct reactions from peers
  DeviceEventEmitter.addListener('p2p_incoming_reaction', async (data) => {
    try {
      const feed = await getLocalP2PFeed();
      const targetPost = feed.find((p) => p.id === data.shareId);
      if (targetPost) {
        const counts = { ...(targetPost.reaction_counts || {}) };
        const emoji = data.emoji || '❤️';
        if (data.action === 'remove') {
          counts[emoji] = Math.max(0, (counts[emoji] || 1) - 1);
        } else {
          counts[emoji] = (counts[emoji] || 0) + 1;
        }
        targetPost.reaction_counts = counts;
        await saveP2PFeedItem(targetPost);
        DeviceEventEmitter.emit('reel-reaction-changed', {
          mediaId: targetPost.id,
          reelId: targetPost.id,
          counts,
          userReactions: targetPost.user_reactions || [],
        });
        DeviceEventEmitter.emit('p2p-feed-updated', feed);
      }
    } catch (err) {
      console.warn('[P2PServer] Error handling incoming reaction:', err);
    }
  });

  // 5. Listen for incoming direct comments from peers
  DeviceEventEmitter.addListener('p2p_incoming_comment', async (data) => {
    try {
      const feed = await getLocalP2PFeed();
      const targetPost = feed.find((p) => p.id === data.shareId);
      if (targetPost) {
        if (!Array.isArray(targetPost.comments)) targetPost.comments = [];

        if (data.action === 'delete') {
          targetPost.comments = targetPost.comments.filter(
            (c) => c.id !== data.commentId && c.comment_id !== data.commentId
          );
        } else if (data.commentJson) {
          try {
            const comment = JSON.parse(data.commentJson);
            const exists = targetPost.comments.some(
              (c) => c.id === comment.id || c.comment_id === comment.comment_id
            );
            if (!exists) {
              const displayName = comment.display_name || comment.author_name || comment.username || comment.device_name || 'Nearby Peer';
              const deviceName = comment.device_name || comment.author_device_name || 'Nearby Device';
              targetPost.comments.push({
                ...comment,
                display_name: displayName,
                device_name: deviceName,
                author_name: displayName,
                author_device_name: deviceName,
                is_own: false,
              });
            }
          } catch {}
        }
        targetPost.comment_count = targetPost.comments.length;
        await saveP2PFeedItem(targetPost);
        DeviceEventEmitter.emit('feed_updated', targetPost);
        DeviceEventEmitter.emit('p2p-feed-updated', feed);

        if (data.action !== 'delete' && data.commentJson) {
          try {
            const comment = JSON.parse(data.commentJson);
            const author = comment.author_name || 'Nearby Peer';
            showNewSharePostNotification({
              id: 'comment_' + Date.now(),
              shared_by: author,
              caption: comment.text ? `💬 "${comment.text}"` : 'Commented on your post',
              files_count: 0,
            }).catch(() => {});
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[P2PServer] Error handling incoming comment:', err);
    }
  });

  // Automatically start daemon and sync feed manifest if P2P mode is enabled
  isP2PEnabled().then((enabled) => {
    if (enabled) {
      startP2PServer().then(() => syncFeedManifest()).catch(() => {});
    }
  });
}

/**
 * Reconciles offline P2P media shares with the desktop server once the server is reachable.
 * Marks media as reconciled after confirmation that the desktop server is connected.
 */
export async function reconcileP2PMediaWithServer() {
  try {
    const feed = await getLocalP2PFeed();
    const unreconciled = feed.filter((post) => post && post.is_p2p && !post.reconciledWithServer);
    if (!unreconciled.length) return { reconciledCount: 0 };

    let count = 0;
    for (const post of unreconciled) {
      await saveP2PFeedItem({ ...post, reconciledWithServer: true });
      count++;
    }

    return { reconciledCount: count };
  } catch (err) {
    console.warn('[P2PServer] P2P reconciliation error:', err?.message);
    return { reconciledCount: 0, error: err?.message };
  }
}
