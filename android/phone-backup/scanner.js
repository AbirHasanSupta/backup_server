import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';

const ALBUMS = ['Camera', 'Download', 'Screenshots'];

export async function scan() {
  const result = [];

  for (const albumName of ALBUMS) {
    const album = await MediaLibrary.getAlbumAsync(albumName);
    if (!album) continue;

    const assets = await MediaLibrary.getAssetsAsync({ album, first: 1000 });

    for (const asset of assets.assets) {
      const info = await FileSystem.getInfoAsync(asset.uri);
      result.push({
        uri: asset.uri,
        relativePath: `${albumName}/${asset.filename}`,
        modifiedTime: Math.floor(asset.modificationTime),
        size: info.size || 0
      });
    }
  }

  return result;
}
