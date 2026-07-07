// Root entry point for the Expo app.
// We import backgroundTask FIRST to ensure that TaskManager.defineTask is called
// as early as possible, which is required for background fetch to work reliably on Android.
import './backgroundTask';
import 'expo-router/entry';
