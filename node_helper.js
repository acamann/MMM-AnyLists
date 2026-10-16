/* MMM-AnyLists node helper
 * Adapted from https://github.com/codetheweb/MMM-AnyList
 *
 * Owns the single shared AnyList client. The front-end communicates only
 * through socket notifications:
 *   INIT        {email, password, lists, refreshOnExternalChange}
 *   TOGGLE_ITEM {listId, identifier}
 *   RETRY       - re-run the last INIT after a failure
 * and receives:
 *   LIST_DATA     {lists: [...]} serialized lists parallel to config.lists
 *   ANYLIST_ERROR {message, detail} display message + full detail for the log
 */

const NodeHelper = require('node_helper');
const AnyList = require('anylist');
const queue = require('async/queue');

// The mirror frequently boots before WiFi has an address, and AnyList is the
// only outbound call on this module. Retry the connect step rather than
// leaving the panel stuck on "Loading ..." until someone touches the Pi.
const INIT_ATTEMPTS = 5;
const INIT_BACKOFF_MS = [2000, 5000, 15000, 30000];

// Network-level failures where `error.response` is undefined. Anything not
// listed (a 401, a protobuf decode failure, a bug) fails fast so real problems
// are not hidden behind five retries.
const TRANSIENT_ERROR_CODES = new Set([
	'EAI_AGAIN',
	'EAI_FAIL',
	'ENOTFOUND',
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNABORTED',
	'EPIPE',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENETDOWN',
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET'
]);

module.exports = NodeHelper.create({
	start() {
		console.log(`Starting node helper: ${this.name}`);

		this.anylist = null;
		this.listNames = [];
		this.lastInit = null;

		// Serialize all AnyList operations — parallel requests cause
		// login/update errors from the AnyList API.
		this.queue = queue(async task => this._processTask(task), 1);

		this.queue.error((err, task) => {
			const message = `MMM-AnyLists experienced an error while processing a ${task.notification} notification: ${this._describeError(err)}`;
			console.error(message);

			// Full stack plus the underlying code — the message alone rarely
			// identifies the failing endpoint or socket.
			console.error(err);

			this.sendSocketNotification('ANYLIST_ERROR', {
				message: this._userFacingError(err),
				detail: message
			});

			// After a failed toggle, resync the front-end with the last known
			// server state so optimistic updates are rolled back.
			if (task.notification === 'TOGGLE_ITEM' && this.anylist) {
				this._sendLists();
			}
		});
	},

	stop() {
		// Without this the websocket and its 5s heartbeat keep the process
		// alive after pm2 asks the server to shut down.
		if (this.anylist) {
			this.anylist.teardown();
			this.anylist = null;
		}
	},

	socketNotificationReceived(notification, payload) {
		if (notification === 'RETRY') {
			payload = this.lastInit;
		}

		if (!payload) {
			return;
		}

		this.queue.push({notification, payload});
	},

	async _processTask({notification, payload}) {
		if (notification === 'INIT' || notification === 'RETRY') {
			await this._init(payload);
		} else if (notification === 'TOGGLE_ITEM') {
			await this._toggleItem(payload);
		} else {
			throw new Error(`Unknown notification: ${notification}`);
		}
	},

	async _init(payload) {
		const {email, password, lists, refreshOnExternalChange} = payload;

		if (!email || !password || email.includes('${') || password.includes('${')) {
			throw new Error('AnyList credentials are missing. Set ANYLIST_EMAIL and ANYLIST_PASSWORD in config/config.env.');
		}

		if (!Array.isArray(lists) || lists.length === 0) {
			throw new Error('No AnyList lists configured.');
		}

		this.listNames = lists;
		this.lastInit = payload;

		// One shared login for the whole module — never log in twice,
		// no matter how many lists are displayed.
		if (!this.anylist) {
			this.anylist = new AnyList({email, password});
			_repairUpstreamDefects(this.anylist);

			if (refreshOnExternalChange !== false) {
				// Push updates when lists change in the AnyList app.
				// The client's `.lists` are refreshed before the event fires.
				this.anylist.on('lists-update', () => this._sendLists());
			}

			await this._withRetry(async () => {
				await this.anylist.login();
				await this.anylist.getLists();
			});
		}

		this._sendLists();
	},

	async _toggleItem({listId, identifier}) {
		if (!this.anylist) {
			throw new Error('Cannot toggle item: not logged in to AnyList yet.');
		}

		const list = this.anylist.getListById(listId);
		if (!list) {
			throw new Error(`Cannot toggle item: list ${listId} not found.`);
		}

		const item = list.getItemById(identifier);
		if (!item) {
			throw new Error(`Cannot toggle item: item ${identifier} not found in list "${list.name}".`);
		}

		item.checked = !item.checked;
		await item.save();
	},

	async _withRetry(fn) {
		let lastError;

		for (let attempt = 1; attempt <= INIT_ATTEMPTS; attempt++) {
			try {
				return await fn();
			} catch (err) {
				lastError = err;

				if (attempt === INIT_ATTEMPTS || !_isTransient(err)) {
					throw err;
				}

				const delay = INIT_BACKOFF_MS[Math.min(attempt - 1, INIT_BACKOFF_MS.length - 1)];
				console.warn(`[MMM-AnyLists] connect attempt ${attempt}/${INIT_ATTEMPTS} failed — ${this._describeError(err)}; retrying in ${delay / 1000}s`);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}

		throw lastError;
	},

	_sendLists() {
		if (!this.anylist) {
			return;
		}

		const lists = this.listNames.map(name => {
			const list = this.anylist.getListByName(name);

			if (!list) {
				return {name, notFound: true};
			}

			// Serialize to plain objects — List/Item instances hold AnyList
			// client references that cannot cross the socket.
			return {
				identifier: list.identifier,
				name: list.name,
				items: list.items.map(item => item.toJSON())
			};
		});

		this.sendSocketNotification('LIST_DATA', {lists});
	},

	_describeError(err) {
		const message = (err && err.message) || String(err);
		const code = err && (err.code || (err.response && err.response.statusCode));
		return code ? `${message} [${code}]` : message;
	},

	_userFacingError(err) {
		if (_isTransient(err)) {
			return 'Cannot reach AnyList — check the mirror’s network connection. Tap to retry.';
		}

		return `AnyList: ${this._describeError(err)}`;
	}
});

/* ---------------------------------------------------------------
 * Repairs to anylist@0.8.6.
 *
 * Both defects below have the same shape: they dereference `error.response`
 * without checking it exists. got's `_error()`
 * (got/dist/source/core/index.js:1194) discards the real error whenever a
 * `beforeError` hook throws, so an ordinary network failure was reported as
 * "Cannot read properties of undefined (reading 'request')" with the actual
 * cause — DNS, refused connection, timeout — thrown away. 0.8.6 is the
 * newest published version, so the fix has to live here.
 * ------------------------------------------------------------- */
function _repairUpstreamDefects(anylist) {
	const options = anylist.client && anylist.client.defaults && anylist.client.defaults.options;

	// `mutableDefaults: true` in the library's client keeps this writable.
	if (options && options.hooks && Array.isArray(options.hooks.beforeError)) {
		const isUnguarded = hook => {
			const source = String(hook);
			return source.includes('response.request.options.url.href') && !source.includes('response &&');
		};

		if (options.hooks.beforeError.some(isUnguarded)) {
			options.hooks.beforeError = options.hooks.beforeError.map(hook => {
				if (!isUnguarded(hook)) {
					return hook;
				}

				return error => {
					const {response} = error;
					if (response && response.request) {
						console.error(`Endpoint ${response.request.options.url.href} returned uncaught status code ${response.statusCode}`);
					}
					return error;
				};
			});

			console.log('[MMM-AnyLists] installed guarded error hook on the AnyList client');
		}
	}

	// The websocket error handler awaits `_refreshTokens()`, which throws
	// "Cannot read properties of undefined (reading 'statusCode')" on exactly
	// the network errors this module is expected to survive. Nothing catches
	// it, so it escapes as an unhandled rejection. Swallow it instead: the
	// disconnect is already logged, and the heartbeat resumes on its own.
	if (typeof anylist._refreshTokens === 'function') {
		const refreshTokens = anylist._refreshTokens.bind(anylist);

		anylist._refreshTokens = async () => {
			try {
				return await refreshTokens();
			} catch (err) {
				console.warn(`[MMM-AnyLists] could not refresh the AnyList access token after a disconnect: ${err.message}`);
			}
		};
	}
}

function _isTransient(err) {
	if (!err) {
		return false;
	}

	if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) {
		return true;
	}

	if (err.name === 'TimeoutError') {
		return true;
	}

	const status = err.response && err.response.statusCode;
	return typeof status === 'number' && (status >= 500 || status === 408 || status === 429);
}
