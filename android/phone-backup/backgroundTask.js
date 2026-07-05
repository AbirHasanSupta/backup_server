import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { scan } from './scanner';
import { uploadFile } from './uploader';
import { isUploaded, markUploaded } from './settings';

const TASK_NAME = 'backup-task';

export async function runSync() {
  const files = await scan();
  let uploadedAny = false;

  for (const file of files) {
    const already = await isUploaded(file.relativePath, file.modifiedTime);
    if (already) continue;

    const success = await uploadFile(file);
    if (success) {
      await markUploaded(file.relativePath, file.modifiedTime);
      uploadedAny = true;
    }
  }

  return uploadedAny;
}

TaskManager.defineTask(TASK_NAME, async () => {
  const uploadedAny = await runSync();
  return uploadedAny
    ? BackgroundFetch.BackgroundFetchResult.NewData
    : BackgroundFetch.BackgroundFetchResult.NoData;
});

export async function registerBackgroundTask() {
  await BackgroundFetch.registerTaskAsync(TASK_NAME, {
    minimumInterval: 15 * 60,
    stopOnTerminate: false,
    startOnBoot: true
  });
}