package com.abirsupta.phonebackup

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.network.OkHttpClientFactory

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

import okhttp3.OkHttpClient
import okhttp3.Dispatcher
import okhttp3.ConnectionPool
import java.util.concurrent.TimeUnit

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          
          add(BackupWakeLockPackage())
// Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        }
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Configure high-performance OkHttp connection pool & dispatcher so UI API calls
    // (Reels, Feed, Library, Thumbnails) execute in parallel without queueing behind active sync uploads.
    OkHttpClientProvider.setOkHttpClientFactory(object : OkHttpClientFactory {
      override fun createNewNetworkModuleClient(): OkHttpClient {
        val dispatcher = Dispatcher().apply {
          maxRequests = 128
          maxRequestsPerHost = 64
        }
        val connectionPool = ConnectionPool(32, 5, TimeUnit.MINUTES)
        return OkHttpClientProvider.createClientBuilder()
          .dispatcher(dispatcher)
          .connectionPool(connectionPool)
          .build()
      }
    })

    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
