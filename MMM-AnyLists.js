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
		header: 'To Do', // '' = no panel header
		showCheckedToggle: true, // render the show/hide-checked button
		hideCheckedItems: true, // initial state, before the user taps
		animationSpeed: 0
	},

	start() {
		this.loaded = false;
		this.error = null;
		this.retrying = false;
		this.showChecked = this._readCheckedVisibility();
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

		const header = this._buildHeader();
		if (header) {
			wrapper.append(header);
		}

		if (this.error) {
			const error = document.createElement('div');
			error.className = 'anylists-error';
			error.textContent = this.error;
			// The helper retries on its own; this is the manual escape hatch
			// for a failure that outlived those attempts.
			error.classList.add('retryable');
			error.addEventListener('click', () => this._retry());
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
			this.retrying = false;
			this.loaded = true;
			this.listsData = payload.lists;
			this.updateDom(this.config.animationSpeed);
		} else if (notification === 'ANYLIST_ERROR') {
			this.retrying = false;
			// The helper sends {message, detail}; detail keeps the full
			// server-side context in the browser console.
			this.error = typeof payload === 'string' ? payload : payload.message;
			if (payload && payload.detail) {
				// eslint-disable-next-line no-console
				console.error(`[MMM-AnyLists] ${payload.detail}`);
			}
			this.updateDom(this.config.animationSpeed);
		}
	},

	_buildHeader() {
		const {header, showCheckedToggle} = this.config;

		// Nothing to draw: no title and no toggle.
		if (!header && !showCheckedToggle) {
			return null;
		}

		const bar = document.createElement('div');
		bar.className = 'anylists-panel-header';

		const title = document.createElement('div');
		title.className = 'anylists-panel-title';
		title.textContent = header;
		bar.append(title);

		if (showCheckedToggle) {
			const toggle = document.createElement('button');
			toggle.type = 'button';
			toggle.className = 'anylists-toggle';
			if (this.showChecked) {
				toggle.classList.add('is-on');
			}

			// Icon only, so the header stays quiet. The wording goes on the
			// tooltip and aria-label.
			const action = this.showChecked ? 'Hide checked items' : 'Show checked items';
			toggle.title = action;
			toggle.setAttribute('aria-label', action);
			toggle.setAttribute('aria-pressed', this.showChecked ? 'true' : 'false');
			toggle.append(_eyeIcon(this.showChecked));

			toggle.addEventListener('click', () => this._toggleCheckedVisibility());
			bar.append(toggle);
		}

		return bar;
	},

	_toggleCheckedVisibility() {
		this.showChecked = !this.showChecked;
		this._saveCheckedVisibility();
		this.updateDom(this.config.animationSpeed);
	},

	// Scoped by identifier so two instances keep separate preferences; the v2
	// prefix retires the key written before `hideCheckedItems` was negated.
	_checkedStorageKey() {
		return `MMM-AnyLists:showChecked:v2:${this.identifier || 'default'}`;
	},

	// Returns `showChecked`, so the config's `hideCheckedItems` has to be
	// negated on the way out — they are opposite questions.
	_readCheckedVisibility() {
		try {
			const stored = window.localStorage.getItem(this._checkedStorageKey());
			if (stored === 'true') {
				return true;
			}
			if (stored === 'false') {
				return false;
			}
		} catch (err) {
			// Storage can be unavailable (disabled, or a browser that throws).
			// The config default is a fine answer either way.
			console.warn(`[MMM-AnyLists] could not read the checked-items preference: ${err.message}`);
		}

		return !this.config.hideCheckedItems;
	},

	_saveCheckedVisibility() {
		try {
			window.localStorage.setItem(this._checkedStorageKey(), this.showChecked ? 'true' : 'false');
		} catch (err) {
			console.warn(`[MMM-AnyLists] could not save the checked-items preference: ${err.message}`);
		}
	},

	_retry() {
		if (this.retrying) {
			return;
		}

		this.retrying = true;
		this.error = null;
		this.sendSocketNotification('RETRY', {});
		this.updateDom(this.config.animationSpeed);

		// If the helper goes quiet (crashed, socket down), let the banner
		// come back rather than leaving a permanent "Loading ...".
		setTimeout(() => {
			if (this.retrying) {
				this.retrying = false;
				this.error = 'No reply from AnyList — tap to retry.';
				this.updateDom(this.config.animationSpeed);
			}
		}, 15000);
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

		const allItems = list.items || [];
		// Filter before slicing so maxItemsPerList counts visible rows.
		let items = this.showChecked ? allItems : allItems.filter(item => !item.checked);

		if (this.config.maxItemsPerList > 0) {
			items = items.slice(0, this.config.maxItemsPerList);
		}

		if (items.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'anylists-status';
			// A column whose items are all checked and hidden is finished, not empty.
			empty.textContent = allItems.length > 0 ? 'All done' : 'No items';
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

/* Eye glyph for the header toggle: a plain eye while checked items are shown,
 * one with a slash across it while they are hidden. Inline SVG keeps the
 * module free of an icon font for the two shapes it needs. */
function _eyeIcon(showing) {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');

	const almond = document.createElementNS(NS, 'ellipse');
	almond.setAttribute('cx', '12');
	almond.setAttribute('cy', '12');
	almond.setAttribute('rx', '10');
	almond.setAttribute('ry', '7');

	const pupil = document.createElementNS(NS, 'circle');
	pupil.setAttribute('cx', '12');
	pupil.setAttribute('cy', '12');
	pupil.setAttribute('r', '2.5');

	if (showing) {
		// Solid eye; the pupil is knocked out in the panel's background color.
		almond.setAttribute('fill', 'currentColor');
		pupil.setAttribute('fill', 'var(--theme-bg, #ffffff)');
		svg.append(almond, pupil);
		return svg;
	}

	almond.setAttribute('fill', 'none');
	almond.setAttribute('stroke', 'currentColor');
	almond.setAttribute('stroke-width', '1.8');
	pupil.setAttribute('fill', 'none');
	pupil.setAttribute('stroke', 'currentColor');
	pupil.setAttribute('stroke-width', '1.8');

	const slash = document.createElementNS(NS, 'line');
	slash.setAttribute('x1', '4');
	slash.setAttribute('y1', '4');
	slash.setAttribute('x2', '20');
	slash.setAttribute('y2', '20');
	slash.setAttribute('stroke', 'currentColor');
	slash.setAttribute('stroke-width', '2');
	slash.setAttribute('stroke-linecap', 'round');

	svg.append(almond, pupil, slash);

	return svg;
}
