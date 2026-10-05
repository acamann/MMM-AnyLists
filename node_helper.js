/* MMM-AnyLists node helper
 * Adapted from https://github.com/codetheweb/MMM-AnyList
 *
 * Owns the single shared AnyList client. The front-end communicates only
 * through socket notifications:
 *   INIT        {email, password, lists, refreshOnExternalChange}
 *   TOGGLE_ITEM {listId, identifier}
 * and receives:
 *   LIST_DATA     {lists: [...]} serialized lists parallel to config.lists
 *   ANYLIST_ERROR human-readable error string
 */

const NodeHelper = require('node_helper');
const AnyList = require('anylist');
const queue = require('async/queue');

module.exports = NodeHelper.create({
	start() {
		console.log(`Starting node helper: ${this.name}`);

		this.anylist = null;
		this.listNames = [];

		// Serialize all AnyList operations — parallel requests cause
		// login/update errors from the AnyList API.
		this.queue = queue(async task => this._processTask(task), 1);

		this.queue.error((err, task) => {
			const message = `MMM-AnyLists experienced an error while processing a ${task.notification} notification: ${err.message || err}`;
			console.error(message);
			this.sendSocketNotification('ANYLIST_ERROR', message);

			// After a failed toggle, resync the front-end with the last known
			// server state so optimistic updates are rolled back.
			if (task.notification === 'TOGGLE_ITEM' && this.anylist) {
				this._sendLists();
			}
		});
	},

	socketNotificationReceived(notification, payload) {
		this.queue.push({notification, payload});
	},

	async _processTask({notification, payload}) {
		if (notification === 'INIT') {
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

		// One shared login for the whole module — never log in twice,
		// no matter how many lists are displayed.
		if (!this.anylist) {
			this.anylist = new AnyList({email, password});

			if (refreshOnExternalChange !== false) {
				// Push updates when lists change in the AnyList app.
				// The client's `.lists` are refreshed before the event fires.
				this.anylist.on('lists-update', () => this._sendLists());
			}

			await this.anylist.login();
			await this.anylist.getLists();
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

	_sendLists() {
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
	}
});
