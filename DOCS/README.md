# docs

## Desktop App

### 1. Server-side sync endpoint (src/server/durable-objects/collie-user.ts)

* Added updated_at columns to feeds and items tables
* Added auto-update triggers for updated_at
* Added migration logic for existing databases
* New endpoint: `GET /api/collie/sync?since=<timestamp>` returns all
  changed data

### 2. Tauri app structure (`src-tauri/`)

* Cargo.toml - Rust dependencies (tauri, tauri-plugin-sql, tauri-plugin-http) 
* tauri.conf.json - App configuration
* src/lib.rs - SQLite migrations and plugin setup
* src/main.rs - Entry point
                                                                              
### 3. Database abstraction layer (src/client/db/)                                
                                                                              
* types.ts - Shared interfaces
* remote-adapter.ts - API adapter for web app
* local-adapter.ts - SQLite adapter for Tauri with sync
* index.ts - Exports appropriate adapter based on environment
                                                                              
### 4. UI sync controls (src/client/components/sidebar-footer.ts)
                                                                              
* "Pull from Server" button (only in Tauri mode)
* Server URL configuration
* Last synced timestamp display
* Error handling
                                                                              
### 5. Build configuration
                                                                              
* vite.config.tauri.js - Vite config without Cloudflare plugins
* Updated package.json with Tauri scripts and dependencies
                                                                              
## To use

### Install dependencies (including Tauri)

```sh
npm install                                                                   
```
                                                                              
### Run the Tauri desktop app in dev mode                                       

```sh
npm run tauri dev                                                             
```
                                                                              
### Build the Tauri app for production                                          

```sh
npm run tauri build                                                           
```
                                                                              
In the desktop app, click "Pull from Server", enter your remote URL (e.g.,
https://your-rsss.workers.dev), and it will sync all feeds and items to your
local SQLite database.
