const defaults = require('lodash.defaults');
const sample = require('lodash.sample');
const clone = require('lodash.clone');
const AbstractEnvironment = require('goose-abstract-environment');
const debugLib = require('debug');
const phantom = require('phantom');
const path = require('path');
const mkdirp = require('mkdirp');
const { parse: parseUrl } = require('url');
const fs = require('fs');

const debug = debugLib('PhantomEnvironment');
const phantomError = debugLib('Phantom:error');
const debugParser = debugLib('RedParser');

function mkdir(...args) {
  return new Promise((resolve, reject) => mkdirp(...args, e => (e ? reject(e) : resolve())));
}

/**
 * @typedef {object} Proxy
 * @property {string} host
 * @property {number} port
 * @property {?string} username
 * @property {?string} password
 */

/**
 * @typedef {object} ProxyIndicator
 * @property {string} type
 * @property {string} level Possible levels - high, medium, low
 */

/**
 * type=redirect
 * @typedef {ProxyIndicator} RedirectProxyIndicator
 * @property {string} url
 */

/**
 * type=responseCode
 * @typedef {ProxyIndicator} ResponceCodeProxyIndicator
 * @property {number} code
 */

/**
 * @typedef {object} Resources
 * @property {?Array.<string>} allowed Only `allowed` resources will be loaded. Have higher priority than `denied`
 * @property {?Array.<string>} denied All except `denied` resources will be loaded
 */

/**
 * @typedef {object} Screen
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {ProxyIndicator} proxyIndicator
 * @returns {Error}
 */
function createProxyError(proxyIndicator) {
  let msg;
  switch (proxyIndicator.type) {
    case 'redirect':
      msg = 'Proxy matched redirect';
      break;
    case 'responseCode':
      msg = 'Proxy matched response code';
      break;
    case 'captcha':
      msg = 'Captcha handled';
      break;
    default:
      throw new Error('Unsupported proxyIndicator');
  }
  const err = new Error(msg);
  err.proxyIndicator = proxyIndicator.type;
  err.proxyLevel = proxyIndicator.level || 'medium';

  return err;
}

/**
 * @param {string} currentUrl
 * @param {string} redirectUri
 * @returns {string}
 * @private
 */
function getRedirectUrl(currentUrl, redirectUri) {
  const parsedCurrentUrl = parseUrl(currentUrl);
  const parsedRedirectUri = parseUrl(redirectUri);
  const hostname = parsedRedirectUri.hostname || parsedCurrentUrl.hostname;
  const protocol = parsedRedirectUri.protocol || parsedCurrentUrl.protocol;

  return protocol + '//' + hostname + parsedRedirectUri.path;
}

/**
 * @param {object} resource
 * @returns {string}
 * @private
 */
function extractRedirectUrl(resource) {
  let redirectUrl;
  if (resource.redirectUrl) {
    redirectUrl = resource.redirectUrl;
  } else {
    const locationHeader = (resource.headers || []).find(
      header => header.name && header.name.toLowerCase() === 'location',
    );

    if (locationHeader && locationHeader.value) {
      redirectUrl = locationHeader.value;
    }
  }

  return redirectUrl ? getRedirectUrl(resource.url, redirectUrl) : '';
}

/**
 * @typedef {object} PhantomEnvironmentOptions
 * @property {?number} timeout
 * @property {?boolean} weak
 * @property {?boolean} loadImages
 * @property {?boolean} ignoreSslErrors
 * @property {?string} sslProtocol
 * @property {?string} cookiesFile
 * @property {?boolean} webSecurity
 * @property {?string} phantomPath
 *
 * @property {?string} snapshot perform snapshot during parsing
 * @property {?string} snapshotDir directory for snapshots
 * @property {?Proxy|Array.<Proxy>} proxy single proxy or proxy list
 * @property {Array.<ProxyIndicator>} proxyIndicators Indicators which say that proxy became unreachable
 * @property {?function} proxyRotator proxy rotator function(proxyList, currentProxy) with context of this env. function
 * should return Proxy from the list
 * @property {?string|Array.<string>} userAgent user agent or list of agents for setting to phantom
 * @property {?Screen} screen screen dimensions
 * @property {?Resources} resources white and black lists for loading resources on the page
 */
const defaultOptions = {
  // Phantom options
  timeout: 60 * 1000,
  weak: true,
  loadImages: false,
  ignoreSslErrors: true,
  sslProtocol: 'any',
  cookiesFile: null,
  webSecurity: false,
  phantomPath: path.join(require.resolve('phantomjs-prebuilt'), '../../bin/'),

  // Custom environment options
  snapshot: false,
  snapshotDir: 'snapshots',
  proxy: null,
  proxyRotator: null,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_4) AppleWebKit/600.7.12 (KHTML, like Gecko) Version/8.0.7 Safari/600.7.12', // eslint-disable-line max-len
  screen: {
    width: 1440,
    height: 900,
  },
  resources: {
    allowed: null,
    denied: null,
  },
};

let port = 13200;

class PhantomEnvironment extends AbstractEnvironment {
  /**
   * @param {PhantomEnvironmentOptions} options
   */
  constructor(options) {
    debug('Initializing...');
    super(options);

    this._options = defaults(clone(options) || {}, defaultOptions);
    this._proxy = this._options.proxy;
    this._proxyIndicators = this._options.proxyIndicators || [];
    this._proxyErrors = [];
    this._proxyCurrent = null;
    this._url = options.url;
    this._redirectUrls = [];
    this._phantomJS = null;
    this._page = null;
    this._exitHandlers = [];
    this._browserEnvInjected = false;
  }

  async prepare() {
    debug('Preparing...');
    await super.prepare();
    await this._setup();
    await this._setViewport();
    await this._setUserAgent();
    await this._setTimeout();
    await this._handlePhantomEvents();
    await this._rotateProxy();
    if (this._url) {
      await this.goto(this._url);
    }
  }

  async goto(url) {
    if (!url) {
      throw new Error('Missing url parameter passed to PhantomEnvironment');
    }
    this._url = url;
    this._proxyErrors = [];
    this._redirectUrls = [];
    this._callbacks = [];

    await this._navigateTo(url);
    await this._validateProxy();
    await this._injectFiles(this._getVendors());
    return this._page;
  }

  setProxy(proxy) {
    this._proxy = proxy;
    return this;
  }

  getProxy() {
    return this._proxy;
  }

  getOption(name) {
    return this._options[name];
  }

  evaluateJs(...args) {
    return new Promise((resolve, reject) => {
      const page = this._page;

      const evalFunc = args.pop();
      if (typeof evalFunc !== 'function') {
        reject(new Error('You must pass function as last argument to PhantomEnvironment.evaluateJs'));
        return;
      }
      args.unshift(evalFunc, results => resolve(results));

      page.evaluate(...args);
    });
  }

  /**
   * Take screen snapshot
   * @param {string} fileName
   * @returns {Promise}
   */
  async snapshot(fileName) {
    const options = this._options;
    if (!options.snapshot) {
      return;
    }

    const screenShotFilePath = path.join(options.snapshotDir, parseUrl(this._url).hostname);
    const screenShotFileName = path.join(screenShotFilePath, fileName + '.png');
    debug('.snapshot() to %s', screenShotFileName);
    await mkdir(screenShotFilePath);

    const windowSize = {
      left: 0,
      top: 0,
      width: options.screen.width,
      height: options.screen.height,
    };
    this._page.clipRect = windowSize;
    debug('Doing snapshot with window size %o, filepath %s', windowSize, screenShotFileName);
    this._page.render(screenShotFileName);

    await new Promise((resolve, reject) => {
      let timeout;

      const interval = setInterval(() => {
        if (fs.statSync(screenShotFilePath).size) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 20);

      timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error('Snapshot timeout'));
      }, 500);
    });
  }

  back() {
    debug('Back');
    this._page.goBack();
    return Promise.resolve();
  }

  async mouseClick(selector) {
    const position = await this._getElementPosition(selector);
    this._page.sendEvent('mousedown', position.x, position.y);
    this._page.sendEvent('mouseup', position.x, position.y);
  }

  async mouseMove(selector) {
    const position = await this._getElementPosition(selector);
    this._page.sendEvent('mousemove', position.x, position.y);
  }

  async mouseDown(selector) {
    const position = await this._getElementPosition(selector);
    this._page.sendEvent('mousedown', position.x, position.y);
  }

  async mouseUp(selector) {
    const position = await this._getElementPosition(selector);
    this._page.sendEvent('mouseup', position.x, position.y);
  }

  async _getElementPosition(selector) {
    const position = await this.evaluateJs(selector, /* @covignore */ (selector) => { // eslint-disable-line no-shadow
      const node = Sizzle(selector)[0]; // eslint-disable-line no-undef
      if (!node) {
        return null;
      }

      const rect = node.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });

    if (!position) {
      throw new Error('Position of element ' + selector + ' was not found');
    }
    debug('Element position is %o', position);
    return position;
  }

  /**
   * Set up a fresh phantomjs page.
   * @returns {Promise}
   * @private
   */
  async _setup() {
    await this._createInstance();
    await this._createPage();
  }

  /**
   * Create a phantomjs instance.
   * @returns {Promise}
   * @private
   */
  _createInstance() {
    return new Promise((resolve) => {
      const options = this._options;
      const flags = [];
      debug('.createInstance() creating Phantom instance with options %o', options);
      flags.push('--load-images=' + options.loadImages);
      flags.push('--ignore-ssl-errors=' + options.ignoreSslErrors);
      flags.push('--ssl-protocol=' + options.sslProtocol);
      flags.push('--web-security=' + options.webSecurity);

      if (options.cookiesFile !== null) {
        flags.push('--cookies-file=' + options.cookiesFile);
      }

      // dnode options for compilation on windows
      let dnodeOpts = {};
      if (options.weak === false) {
        dnodeOpts = { weak: false };
      }

      // combine flags, options and callback into args
      const args = flags;
      args.push({
        port: options.port || (port += 1),
        dnodeOpts,
        path: options.phantomPath,
        onExit: this._handleExit.bind(this),
      });
      args.push((instance) => {
        this._phantomJS = instance;
        resolve(instance);
      });
      phantom.create(...args);
    });
  }

  /**
   * Creates new page in phantom
   * @returns {Promise}
   */
  _createPage() {
    return new Promise((resolve) => {
      debug('._createPage() has called');
      this._phantomJS.createPage((page) => {
        this._page = page;
        debug('._createPage() phantom page created');
        resolve(page);
      });
    });
  }

  /**
   * Tear down a phantomjs instance.
   */
  tearDown() {
    return new Promise((resolve) => {
      debug('._tearDownInstance() tearing down');
      const phantomJs = this._phantomJS;
      if (!phantomJs || !phantomJs.process) {
        debug('Phantom process already exited, not killing');
        resolve();
        return;
      }

      const pid = phantomJs.process.pid;

      debug('Terminating phantom process gracefully, pid: ', pid);
      if (this._page) {
        this._page.close();
        delete this._page;
      }

      phantomJs.exit();

      let timeout;

      function resolver() {
        clearTimeout(timeout);
        resolve();
      }

      timeout = setTimeout(() => {
        const i = this._exitHandlers.indexOf(resolver);
        if (i !== -1) {
          this._exitHandlers.splice(i, 1);
        }

        debug('phantom time is out, kill it and go ahead');
        if (phantomJs.process) {
          phantomJs.process.kill('SIGKILL');
        }

        resolve();
      }, 5000); // 5 sec to die

      this._exitHandlers.push(resolver);

      delete this._phantomJS;
    });
  }

  /**
   * Handles the phantom process ending/crashing unexpectedly.
   * If an `onExit` handler has been bound then that will be called. Otherwise, the error will be re-thrown.
   * @param {Number} code
   * @param {String} [signal]
   */
  _handleExit(code, signal) {
    debug('Phantom exited with code ' + code + ' and signal ' + signal);
    // delete this._phantomJS.process;

    // otherwise, if we have a non-zero code we'll throw a better error message
    // than the `phantom` lib would.
    if (code !== 0) {
      const err = new Error('The PhantomJS process ended unexpectedly');
      err.code = code;
      err.signal = signal;
      // throw err;
    }

    this._exitHandlers.forEach(handler => handler(code));
    this._exitHandlers = [];
  }

  /**
   * Go to url
   * @param url
   * @returns {Promise}
   * @private
   */
  _navigateTo(url) {
    return new Promise((resolve, reject) => {
      this._openPage(url, resolve, reject);
    });
  }

  _openPage(url, resolve, reject) {
    debug('.goto() url: ' + url);
    this._page.open(url, async (status) => {
      debug('.goto() page loaded: ' + status);
      if (status === 'success') {
        resolve();
        return;
      }

      try {
        const proxy = await this._rotateProxy();
        // cannot set new proxy
        if (proxy === null) {
          reject(new Error(`Page ${url} was not loaded`));
          return;
        }

        // one more attempt to open page through the new proxy
        this._openPage(url, resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Set the viewport.
   *
   * @returns {Promise}
   * @private
   */
  _setViewport() {
    return new Promise((resolve) => {
      let screen = this._options.screen;
      if (Array.isArray(screen)) {
        screen = sample(screen);
      }
      const width = screen.width;
      const height = screen.height;
      debug('.viewport() to ' + width + ' x ' + height);
      const viewport = { width, height };
      this._options.screen = viewport;
      this._page.set('viewportSize', viewport, () => resolve());
    });
  }

  /**
   * Set the user agent.
   *
   * @returns {Promise}
   * @private
   */
  _setUserAgent() {
    return new Promise((resolve) => {
      let userAgent = this._options.userAgent;
      if (Array.isArray(userAgent)) {
        userAgent = sample(this._options.userAgent);
      }
      debug('.userAgent() to ' + userAgent);
      this._page.set('settings.userAgent', userAgent, () => resolve());
    });
  }

  /**
   * Set timeout.
   *
   * @returns {Promise}
   * @private
   */
  _setTimeout() {
    return new Promise((resolve) => {
      const timeout = this._options.timeout;
      debug('.timeout() to ' + timeout);
      this._page.set('settings.resourceTimeout', timeout, () => resolve());
    });
  }

  /**
   * @param {Error} error
   */
  addProxyError(error) {
    this._proxyErrors.push(error);
  }

  /**
   * @returns {Array.<Error>}
   */
  getProxyErrors() {
    return this._proxyErrors;
  }

  /**
   * @param type
   * @returns {Array.<ProxyIndicator>}
   */
  getProxyIndicators(type) {
    return this._proxyIndicators.filter(item => item.type === type);
  }

  /**
   * @returns {Promise}
   * @private
   */
  _validateProxy() {
    return this.getProxyErrors().length === 0 ?
      Promise.resolve() :
      Promise.reject(this.getProxyErrors().pop());
  }

  /**
   * Set a proxy from the proxy list (unset previous one)
   *
   * @returns {Promise}
   * @private
   */
  async _rotateProxy() {
    const proxy = this._proxy;
    const currentProxy = this._proxyCurrent;
    if (!proxy) {
      return null;
    }

    if (!Array.isArray(proxy)) {
      return this._applyProxy(proxy);
    }

    this._removeUnavailableProxy();
    const { proxyRotator } = this._options;
    const foundProxy = typeof proxyRotator === 'function'
      ? await proxyRotator(proxy, currentProxy)
      : sample(proxy);

    this._proxyErrors = [];
    if (!foundProxy) {
      throw new Error('No proxy found');
    }
    return this._applyProxy(foundProxy);
  }

  /**
   * Apply proxy to Phantom
   * @private
   */
  _applyProxy(proxy) {
    return new Promise((resolve) => {
      this._phantomJS.setProxy(proxy.host, proxy.port, 'manual', proxy.username, proxy.password, () => {
        debug('Proxy applied %o', proxy);
        this._proxyCurrent = proxy;
        resolve(proxy);
      });
    });
  }

  /**
   * Remove from proxy list one which doesn't work
   *
   * @returns {?Proxy}
   * @private
   */
  _removeUnavailableProxy() {
    const current = this._proxyCurrent;
    if (!Array.isArray(this._proxy) || this._proxy.length === 0 || current === null) {
      return null;
    }

    debug('._removeUnavailableProxy()');
    const index = this._proxy.findIndex(item => item.host === current.host && item.port === current.port);
    let proxy = null;
    if (index !== -1) {
      // cut off old used proxy from the list
      proxy = this._proxy.splice(index, 1);
    }
    return Array.isArray(proxy) ? proxy.pop() : null;
  }

  _injectFiles(filePaths) {
    filePaths.forEach((filePath) => {
      debug('injecting file %s', filePath);
      this._page.injectJs(filePath);
    });
    return Promise.resolve();
  }

  injectBrowserEnv() {
    if (this._browserEnvInjected) {
      return Promise.resolve();
    }

    debug('.inject()-ing browser env libs');
    return this._injectFiles([
      path.join(__dirname, '../build/browser.bundle.js'),
    ]);
  }

  /**
   * @param {string} [urlPattern]
   * @returns {boolean}
   */
  hasRedirect(urlPattern) {
    if (urlPattern === undefined) {
      return this._redirectUrls.length > 0;
    }
    return this._redirectUrls.some(url => url.match(urlPattern) !== null);
  }

  _handlePhantomEvents() {
    const page = this._page;

    page.set('onError', (msg, trace) => {
      phantomError('%s, trace %o', msg, trace);
      // this._errbacks.splice(0).forEach(errback => errback(msg, trace));
    });

    // todo: make it workable
    page.set('onConsoleMessage', (msg) => {
      const regex = /^(\[GooseParser])(.+)/i;
      const found = msg.match(regex);

      if (found) {
        debugParser(found[2].trim());
      } else {
        debug('Phantom page message: ' + msg);
      }
    });

    page.set('onNavigationRequested', (url) => {
      debug('Navigation to %s', url);
      this.evaluateCallbacks('request', url);
    });

    page.set('onLoadFinished', (status) => {
      debug('Page loaded with status %s', status);
      const args = {};
      if (status === 'success') {
        args.error = new Error('Page is not loaded');
      }
      this.evaluateCallbacks('navigation', null, args);
    });

    page.set('onResourceError', (resourceError) => {
      debug('Navigation error %s %s', resourceError.url, resourceError.errorString);
      const matched = this.getProxyIndicators('responseCode').find(item => item.code === resourceError.status);
      if (matched) {
        this.addProxyError(createProxyError(matched));
      }
    });

    page.onResourceRequested(/* @covignore */ (requestData, request, allowedUrls, blockedUrls) => {
      const url = requestData.url;
      const hasAllowedUrls = Array.isArray(allowedUrls) && allowedUrls.length > 0;
      const hasBlockedUrls = Array.isArray(blockedUrls) && blockedUrls.length > 0;
      const allowed = !hasAllowedUrls || allowedUrls.some(urlPattern => url.match(urlPattern) !== null);

      let blocked = false;
      if (!hasAllowedUrls && hasBlockedUrls) {
        blocked = blockedUrls.some(urlPattern => url.match(urlPattern) !== null);
      }

      if (!allowed || blocked) {
        console.log( // eslint-disable-line no-console
          '[GooseParser] Resource ' + requestData.url.substr(0, 30) + ' was aborted',
        );
        request.abort();
      }
    }, () => {}, this._options.resources.allowed, this._options.resources.denied);

    page.set('onResourceReceived', (resource) => {
      // redirect has occurred
      if ([302, 301].indexOf(resource.status) !== -1) {
        const redirectUrl = extractRedirectUrl(resource) || '';

        // if current url matches with this._url or with the last redirect url from this._redirectUrls
        if (
          redirectUrl &&
          (
            resource.url === this._url ||
            resource.url === this._redirectUrls[this._redirectUrls.length - 1]
          )
        ) {
          debug('Redirect to %s', redirectUrl);
          this._redirectUrls.push(redirectUrl);
        }
        const matched = this.getProxyIndicators('redirect').find(item => redirectUrl.match(item.url));
        if (matched) {
          this.addProxyError(createProxyError(matched));
        }
      }
    });
  }
}

module.exports = PhantomEnvironment;
