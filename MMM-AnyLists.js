/* MMM-AnyLists
 * MagicMirror² module — adapted from https://github.com/codetheweb/MMM-AnyList
 *
 * Displays multiple AnyList lists side-by-side (one column per list) and
 * lets you tap an item to toggle its checked state. Toggles are persisted
 * to AnyList by the node helper; external changes arrive via AnyList's
 * websocket-driven `lists-update` event.
 */

// eslint-disable-next-line no-undef
Module.register('MMM-AnyLists', {
	defaults: {
		email: '',
		password: '',
		lists: [],
		refreshOnExternalChange: true,
		maxItemsPerList: 0, // 0 = unlimited
		textAlign: 'left', // 'left' / 'center'
		showQuantities: false,
		columnSeparator: true,
		animationSpeed: 0
	},

	start() {
		this.loaded = false;
		this.error = null;
		// Parallel to config.lists: serialized list object, {name, notFound: true},
		// or null until data arrives.
		this.listsData = this.config.lists.map(() => null);

		if (!Array.isArray(this.config.lists) || this.config.lists.length === 0) {
			this.error = 'MMM-AnyLists: no lists configured. Set config.lists to your AnyList list names.';
			this.loaded = true;
			return;
		}

		// Send user config to the backend. The backend replies with
		// LIST_DATA / ANYLIST_ERROR socket notifications.
		this.sendSocketNotification('INIT', {
			email: this.config.email,
			password: this.config.password,
			lists: this.config.lists,
			refreshOnExternalChange: this.config.refreshOnExternalChange
		});
	},

	getStyles() {
		return ['MMM-AnyLists.css'];
	},

	getDom() {
		const wrapper = document.createElement('div');
		wrapper.className = 'anylists';

		if (this.error) {
			const error = document.createElement('div');
			error.className = 'anylists-error';
			error.textContent = this.error;
			wrapper.append(error);
		}

		if (!this.loaded) {
			const loading = document.createElement('div');
			loading.className = 'anylists-status';
			loading.textContent = 'Loading …';
			wrapper.append(loading);
			return wrapper;
		}

		const columns = document.createElement('div');
		columns.className = 'anylists-columns';
		if (this.config.columnSeparator) {
			columns.classList.add('with-separators');
		}
		if (this.config.textAlign === 'center') {
			columns.classList.add('center-aligned');
		}

		this.listsData.forEach((list, index) => {
			columns.append(this._buildColumn(list, index));
		});

		wrapper.append(columns);

		return wrapper;
	},

	socketNotificationReceived(notification, payload) {
		if (notification === 'LIST_DATA') {
			this.error = null;
			this.loaded = true;
			this.listsData = payload.lists;
			this.updateDom(this.config.animationSpeed);
		} else if (notification === 'ANYLIST_ERROR') {
			this.error = payload;
			this.updateDom(this.config.animationSpeed);
		}
	},

	_buildColumn(list, index) {
		const column = document.createElement('div');
		column.className = 'anylists-column';

		const header = document.createElement('div');
		header.className = 'anylists-header';
		header.textContent = list ? list.name : this.config.lists[index];
		column.append(header);

		if (!list || list.notFound) {
			const status = document.createElement('div');
			status.className = 'anylists-status';
			status.textContent = list && list.notFound ? 'List not found in AnyList' : 'Loading …';
			column.append(status);
			return column;
		}

		let items = list.items || [];

		if (this.config.maxItemsPerList > 0) {
			items = items.slice(0, this.config.maxItemsPerList);
		}

		if (items.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'anylists-status';
			empty.textContent = 'No items';
			column.append(empty);
			return column;
		}

		const itemList = document.createElement('ul');
		itemList.className = 'anylists-items';

		items.forEach(item => {
			const row = document.createElement('li');
			row.className = item.checked ? 'anylists-item checked' : 'anylists-item';

			const checkbox = document.createElement('span');
			checkbox.className = 'anylists-checkbox';
			row.append(checkbox);

			const name = document.createElement('span');
			name.className = 'anylists-item-name';
			name.textContent = item.name;
			row.append(name);

			if (this.config.showQuantities && item.quantity) {
				const quantity = document.createElement('span');
				quantity.className = 'anylists-item-quantity';
				quantity.textContent = item.quantity;
				row.append(quantity);
			}

			row.addEventListener('click', () => {
				this._toggleItem(list.identifier, item.identifier);
			});

			itemList.append(row);
		});

		column.append(itemList);

		return column;
	},

	_toggleItem(listId, identifier) {
		// Optimistic update so the tap feels instant; the next LIST_DATA
		// (driven by AnyList's websocket `lists-update` event) reconciles state.
		const list = this.listsData.find(l => l && l.identifier === listId);
		const item = list && (list.items || []).find(i => i.identifier === identifier);

		if (item) {
			item.checked = !item.checked;
			this.updateDom(this.config.animationSpeed);
		}

		this.sendSocketNotification('TOGGLE_ITEM', {listId, identifier});
	}
});
