Here is the content of the
**[demo-123.md](https://sqlite.org/wasm/doc/trunk/demo-123.md)**
page from the SQLite Wasm documentation, formatted in Markdown:

---

# A Database in your Browser in sqlite3 Steps

What follows is a demonstration of how to get sqlite3 up and running in a browser[^1] in a few brief steps. For simplicity's sake, this tutorial will demonstrate loading the sqlite3 JavaScript/WebAssembly (WASM) module in the so-called main thread of a web page. Using the module from a worker requires only a small bit more effort and will be covered in a later tutorial, as will how to make use of various persistent-storage options.

Before we begin, be aware of the following limitations of the approach demonstrated here:

* This demonstration uses "vanilla" JavaScript with no third-party tooling requirements. Using it with `npm` is covered in a [separate page](https://sqlite.org/wasm/doc/trunk/npm-setup.md).
* **Databases are transient** - they disappear when the page is reloaded. Persisting them is possible but beyond the scope of this brief tutorial.
* **Database size limits** are entirely dependent on the browser and the device. The library has no reliable way of querying those limits.
* **Use of the browser's main thread** (also called the "UI thread") for long-running operations is widely discouraged because the UI cannot be rendered while JS code is running. Though simple database operations on relatively small databases should pose no usability issues, it is generally preferred to load and run sqlite3 from a Worker so that long-running queries do not interfere with the UI rendering. The library offers several different ways of doing that.

## Step 1: Create the HTML

At its most basic, we need HTML scaffolding which loads both the main `sqlite3.js` and a client application which uses it. For example:

```html
<!doctype html>
<html lang="en-us">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <title>Hello, sqlite3</title>
  </head>
  <body>
    <script src="jswasm/sqlite3.js"></script>
    <script src="demo-123.js"></script>
  </body>
</html>
```

See [demo-123.html](https://sqlite.org/wasm/doc/trunk/demo-123.html) for one with slightly more flavor.

## Step 2: Create a JS App

With the HTML out of the way, we need our JavaScript application. The most fundamental part is the loading of the WASM-compiled form of the library and initialization of its JavaScript binding. That is all performed via a routine exported by `sqlite3.js`:

```javascript
window.sqlite3InitModule().then(function(sqlite3){
  // The module is now loaded and the sqlite3 namespace
  // object was passed to this function.
  console.log("sqlite3:", sqlite3);
});
```

See [demo-123.js](https://sqlite.org/wasm/doc/trunk/demo-123.js) for a "full-featured" example and demonstration of the high-level sqlite3 JS API.

The `sqlite3InitModule()` function is the only global symbol exported by the sqlite3 WASM module loader and it must be called only a single time in any application. It is the application's responsibility to store the `sqlite3` object wherever is convenient for the application. At its simplest:

```javascript
globalThis.sqlite3 = sqlite3;
```

will install it as a global symbol[^2], but such use of the global scope is discouraged in most projects.

Note that on a slow connection, downloading the WASM file (a step triggered by `sqlite3InitModule()`) may take some time, during which the demo will appear to be inactive. The application may add additional HTML, CSS, and JS bits in order to receive notifications about the loading status so that, for example, the UI can show a "loading..." animation or report any errors. Doing so requires becoming familiar with the Emscripten-provided JS/WASM scaffolding and is beyond the scope of this demonstration. An example is available at the bottom of the sqlite3 [fiddle application](https://sqlite.org/wasm/fiddle).

## Step 3: The Web Server

With the HTML and JS in place, we require a web server in order to run them. Due to security limitations, browsers may refuse to load WASM from pages served via `file://` URLs. As the web server is largely a matter of personal preference, and many options are available, getting that part running is out of scope here.

In short, we need the following files to be in the same directory on some arbitrary web server:

* `demo-123.html`
* `demo-123.js`
* `sqlite3.js` - contains the WASM module loader and the sqlite3 JS API.
* `sqlite3.wasm` - is the compiled-to-WASM build of the core sqlite3 library.

With the web server up and running, we simply need to point our browser to the location of the demo file(s):

* [demo-123.html](https://sqlite.org/wasm/doc/trunk/demo-123.html) ([plain text](https://sqlite.org/wasm/file/doc/trunk/demo-123.html?txt=1))
* [demo-123-worker.html](https://sqlite.org/wasm/doc/trunk/demo-123-worker.html) ([plain text](https://sqlite.org/wasm/file/doc/trunk/demo-123-worker.html?txt=1))

***

[^1]: A recent (post-2020), full-featured browser is required. Firefox and the Chrome family of browsers are known to be sufficient on most platforms. This framework currently targets only browsers, not non-browser runtimes such as node.js.

[^2]: The symbols `globalThis` and `self` refer to the global object in the main thread and Worker threads. The name `globalThis` is more portable to non-browser platforms and is supported in all JS-relevant browsers.