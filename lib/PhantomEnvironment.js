const _ = require('lodash');
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

class PhantomEnvironment extends AbstractEnvironment {
  /**
   * @param {PhantomEnvironmentOptions} options
   */
  constructor(options) {
    debug('Initializing...');
    super(options);

    this._options = _.defaults(_.clone(options) || {}, defaultOptions);
    this._proxy = this._options.proxy;
    this._proxyIndicators = this._options.proxyIndicators || [];
    this._proxyErrors = [];
    this._proxyCurrent = null;
    this._url = options.url;
    this._redirectUrls = [];

    if (!this._url) {
      throw new Error('You must pass `url` to PhantomEnvironment');
    }

    this._phantomJS = null;
    this._page = null;
    this._navigationActions = [];
    this._requestingActions = [];
    this._exitHanlers = [];
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
    await this._navigateTo(this._url);
    await this._validateProxy();
    await this._injectVendors();
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

  async waitForPage(timeout = 5000) {
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        debug('Timeout %s has reached on page load', timeout);
        this._navigationActions = [];
        reject(new Error('Page navigation timeout'));
      }, timeout);

      this._navigationActions.push((err) => {
        clearTimeout(timeoutId);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
      debug('Added page load callback');
    });
    await this._injectVendors();
  }

  waitForQuery(uri, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        debug('Timeout %s has reached for waiting query %s', timeout, uri);
        this._requestingActions = [];
        reject(new Error('Waiting request timeout'));
      }, timeout);

      this._requestingActions.push({
        pattern: uri,
        fn(err, results) {
          clearTimeout(timeoutId);
          if (err) {
            reject(err);
          } else {
            resolve(results);
          }
        },
      });
      debug('Added request callback');
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

  async mousedown(selector) {
    const position = await this._getElementPosition(selector);
    this._page.sendEvent('mousedown', position.x, position.y);
  }

  async mouseup(selector) {
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
  async _createInstance() {
    const options = this._options;
    const args = [];
    debug('.createInstance() creating Phantom instance with options %o', options);
    args.push('--load-images=' + options.loadImages);
    args.push('--ignore-ssl-errors=' + options.ignoreSslErrors);
    args.push('--ssl-protocol=' + options.sslProtocol);
    args.push('--web-security=' + options.webSecurity);

    this._phantomJS = await phantom.create(args, {
      path: options.phantomPath,
      onExit: this._handleExit.bind(this),
    });

    return this._phantomJS;
  }

  /**
   * Creates new page in phantom
   * @returns {Promise}
   */
  async _createPage() {
    this._page = await this._phantomJS.createPage();
    debug('._createPage() phantom page created');

    return this._page;
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
        const i = this._exitHanlers.indexOf(resolver);
        if (i !== -1) {
          this._exitHanlers.splice(i, 1);
        }

        debug('phantom time is out, kill it and go ahead');
        if (phantomJs.process) {
          phantomJs.process.kill('SIGKILL');
        }

        resolve();
      }, 5000); // 5 sec to die

      this._exitHanlers.push(resolver);

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

    this._exitHanlers.forEach(handler => handler(code));
    this._exitHanlers = [];
  }

  /**
   * Go to url
   * @param url
   * @returns {Promise}
   * @private
   */
  async _navigateTo(url) {
    return this._openPage(url);
  }

  async _openPage(url) {
    debug('.goto() url: ' + url);
    const status = await this._page.open(url);

    if (status === 'success') {
      return;
    }

    const proxy = await this._rotateProxy();
    // cannot set new proxy
    if (proxy === null) {
      throw new Error(`Page ${url} was not loaded`);
    }

    // one more attempt to open page through the new proxy
    // todo: sounds like infinity recursion
    await this._openPage(url);
  }

  /**
   * Set the viewport.
   *
   * @returns {Promise}
   * @private
   */
  async _setViewport() {
    const viewport = this.getViewport();
    debug('.viewport() to ' + viewport.width + ' x ' + viewport.height);
    return this._page.property('viewportSize', viewport);
  }

  /**
   * @private
   */
  getViewport() {
    let screen = this._options.screen;
    if (Array.isArray(screen)) {
      screen = _.sample(screen);
    }
    const width = screen.width;
    const height = screen.height;
    return { width, height };
  }

  /**
   * Set the user agent.
   *
   * @returns {Promise}
   * @private
   */
  async _setUserAgent() {
    const userAgent = this.getUserAgent();
    debug('.userAgent() to ' + userAgent);
    return this._page.setting('userAgent', userAgent);
  }

  getUserAgent() {
    return Array.isArray(this._options.userAgent) ?
      _.sample(this._options.userAgent) :
      this._options.userAgent;
  }

  /**
   * Set timeout.
   *
   * @returns {Promise}
   * @private
   */
  async _setTimeout() {
    const timeout = this._options.timeout;
    debug('.timeout() to ' + timeout);
    return this._page.setting('resourceTimeout', timeout);
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
  async _validateProxy() {
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
      : _.sample(proxy);

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
  async _applyProxy(proxy) {
    await this._page.setProxy(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}/`);
    // await this._phantomJS.setProxy(proxy.host, proxy.port, 'manual', proxy.username, proxy.password);
    debug('Proxy applied %o', proxy);
    this._proxyCurrent = proxy;
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

  async _handlePhantomEvents() {
    const page = this._page;

    await page.property('onError', function (msg, trace) {
      phantomError('%s, trace %o, fire %s errbacks', msg, trace, this._errbacks.length);
      // this._errbacks.splice(0).forEach(errback => errback(msg, trace));
    });

    await page.property('onConsoleMessage', (msg) => {
      const regex = /^(\[GooseParser])(.+)/i;
      const found = msg.match(regex);

      if (found) {
        debugParser(found[2].trim());
      } else {
        debug('Phantom page message: ' + msg);
      }
    });

    await page.property('onNavigationRequested', function (url) {
      debug('Navigation to %s', url);
      let i = 0;
      const actions = this._requestingActions;
      while (i < actions.length) {
        const action = actions[i];
        if (url.match(action.pattern)) {
          actions.shift();
          action.fn(null, url);
        } else {
          i += 1;
        }
      }
    });

    await page.property('onLoadFinished', function (status) {
      debug('Page loaded with status %s, fire %s callbacks', status, this._navigationActions.length);
      this._navigationActions.splice(0).forEach(function (callback) {
        callback.call(this, status === 'success' ? null : new Error('Page is not loaded'));
      });
    });

    await page.property('onResourceError', function (resourceError) {
      debug('Navigation error %s %s', resourceError.url, resourceError.errorString);
      const matched = this.getProxyIndicators('responseCode').find(item => item.code === resourceError.status);
      if (matched) {
        this.addProxyError(createProxyError(matched));
      }
    });

    // eslint-ignore-next-line prefer-arrow-callback
    await page.property('onResourceRequested', (requestData, request, allowedUrls, blockedUrls) => {
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
    }, this._options.resources.allowed, this._options.resources.denied);

    await page.property('onResourceReceived', function (resource) {
      // redirect has occurred
      if ([302, 301].includes(resource.status)) {
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
