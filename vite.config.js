export default defineConfig({
  base: '/Better-Mapng/',

  plugins: [
    vue({
      ...templateCompilerOptions
    })
  ],

  optimizeDeps: {
    exclude: ['geotiff'],
    include: ['laz-perf/lib/worker'],
  },

  css: {
    devSourcemap: false
  },

  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'three': ['three'],
          'leaflet': ['leaflet'],
          'geotiff': ['geotiff'],
          'proj4': ['proj4']
        }
      }
    }
  },

  // keep the rest of your existing config...
});
