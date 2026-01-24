# Cloud Collie

[Collie RSS reader](https://github.com/collie-reader/collied) + Bluesky OAuth.

<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Develop](#develop)
- [Architecture](#architecture)
  * [Worker (Hono) - Main entry point](#worker-hono---main-entry-point)
  * [Durable Object per user (CollieUserDO)](#durable-object-per-user-collieuserdo)
  * [Frontend](#frontend)
- [Files](#files)
- [Running Locally](#running-locally)
- [Deploy](#deploy)

<!-- tocstop -->

</details>


## Develop

```sh
npm start
```

## Architecture                                                                  
                                                                                
### Worker (Hono) - Main entry point

* Bluesky OAuth authentication (AT Protocol)
* Session management with encrypted cookies
* Routes requests to user-specific Durable Objects
* Static asset serving for the Preact frontend
                                                                              
### Durable Object per user (CollieUserDO)

* Uses SQLite storage for feeds and items
* Uses the Hibernation API (extends DurableObject)
* Alarms for periodic feed refreshing (every 10 minutes)
* Complete RSS/Atom feed parser
                                                                              
### Frontend

* Login page with Bluesky OAuth                                               
* Feed management (add/delete/refresh)                                        
* Item list with filtering (unread/starred/by feed)                           
* Item reader with read/star toggles                                          
* Responsive design                                                           


## Files                                                                     

```
src/                                                                          
├── server/                                                                   
│   ├── index.ts                    # Main Hono worker                        
│   ├── auth/oauth.ts               # Bluesky OAuth implementation            
│   └── durable-objects/                                                      
│       └── collie-user.ts          # Per-user DO with SQLite                 
└── client/                                                                   
    ├── index.ts                    # Main Preact entry                       
    ├── state.ts                    # State management & API client           
    ├── style.css                   # All styles                              
    └── routes/                                                               
        ├── login.ts                # Login page component                    
        └── feed-reader.ts          # Main feed reader UI                     
```
                                                                              
## Running Locally                                                               

```sh
npm run start           # Start dev server
```
                                                                              
Then access `http://localhost:8888` and use the "Dev Login" button in           
development mode.
                                                                              
## Deploy
                                                                              
1. Create a KV namespace for sessions:
```sh
wrangler kv:namespace create SESSIONS                                         
```
2. Update wrangler.jsonc with the KV ID                                       
3. Set secrets:                                                               
```sh
wrangler secret put SESSION_SECRET                                            
```
4. Deploy:                                                                    
```sh
wrangler deploy                      
```

## Notes

### Generate a Secret

```sh
openssl rand -base64 32
```