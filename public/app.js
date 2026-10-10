const uploadDialog = document.querySelector('#upload-dialog');
const reconcileDialog = document.querySelector('#reconcile-dialog');
const fileInput = document.querySelector('#file-input');
const dropzone = document.querySelector('#dropzone');
const confirmUpload = document.querySelector('#confirm-upload');
const uploadButtonLabel = document.querySelector('#upload-button-label');
const uploadError = document.querySelector('#upload-error');
const reconcileForm = document.querySelector('#reconcile-form');
const damageDialog = document.querySelector('#rt-damage-dialog');
const damageForm = document.querySelector('#rt-damage-form');
const exportButton = document.querySelector('#export-day');
const toast = document.querySelector('#toast');

let deliveries = [];
let deliveryPartners = [];
let currentUser = null;
let selectedFile = null;
let activeBill = null;
let editingDamageReportId = null;
let selectedSalesmanFilter = '';
let hasInitializedDeliveryDate = false;
const selectedBillIds = new Set();
let toastTimeout;
let selectedDeliveryDate = getLocalDateValue();

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[character]));

function showToast(message, isError = false) {
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 3500);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error(`The server returned an unreadable response (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(body.error || `The request failed (${response.status}).`);
  }

  return body;
}

function formatDate(value) {
  if (!value) return 'Recently added';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? 'Recently added' : new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function formatCurrency(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value));
}

function formatDuration(start, end = new Date()) {
  if (!start) return '';
  const startTime = new Date(start).getTime();
  const endTime = end instanceof Date ? end.getTime() : new Date(end).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime) return '';

  const totalMinutes = Math.floor((endTime - startTime) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getLocalDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getBillDeliveryDate(bill) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bill.delivery_date || '')) {
    return bill.delivery_date;
  }

  const createdAt = String(bill.created_at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(createdAt) ? createdAt : '';
}

function getSelectedDayDeliveries() {
  return deliveries.filter(bill => {
    const isScheduledForDate = getBillDeliveryDate(bill) === selectedDeliveryDate;
    const isCarryover = bill.status === 'Not supplied' &&
      /^\d{4}-\d{2}-\d{2}$/.test(bill.not_supplied_from_date || '') &&
      bill.not_supplied_from_date <= selectedDeliveryDate;
    return isScheduledForDate || isCarryover;
  });
}

function getDeliveryAgentDeliveries(dayDeliveries = getSelectedDayDeliveries()) {
  const deliveryAgent = document.querySelector('#delivery-agent-filter').value;
  if (!deliveryAgent) return dayDeliveries;
  return dayDeliveries.filter(bill => deliveryAgent === 'unassigned'
    ? !bill.assigned_to
    : String(bill.assigned_to || '') === deliveryAgent);
}

function getQuantities(bill) {
  const total = bill.items.reduce((sum, item) => sum + Number(item.qty_ordered), 0);
  const delivered = bill.items.reduce((sum, item) => sum + Number(item.qty_delivered), 0);
  const returned = bill.items.reduce((sum, item) => sum + Number(item.qty_returned), 0);
  return {
    total,
    delivered,
    returned,
    resolved: delivered + returned,
    remaining: Math.max(0, total - delivered - returned)
  };
}

function statusClass(status) {
  return {
    Pending: 'status-pending',
    'In progress': 'status-in-progress',
    'Not supplied': 'status-not-supplied',
    Completed: 'status-completed',
    Returned: 'status-returned'
  }[status] || 'status-pending';
}

function updateSummary() {
  const allDayDeliveries = getSelectedDayDeliveries();
  const dayDeliveries = getDeliveryAgentDeliveries(allDayDeliveries);
  const count = { Pending: 0, 'In progress': 0, Completed: 0, Returned: 0 };
  dayDeliveries.forEach(bill => {
    count[bill.status] = (count[bill.status] || 0) + 1;
  });

  const pendingBills = dayDeliveries.filter(bill => getQuantities(bill).remaining > 0).length;
  const pendingUnits = dayDeliveries.reduce((sum, bill) => sum + getQuantities(bill).remaining, 0);
  exportButton.disabled = allDayDeliveries.length === 0;
  exportButton.title = allDayDeliveries.length
    ? `Download the ${formatDate(selectedDeliveryDate)} delivery report as an Excel workbook`
    : `No deliveries to export for ${formatDate(selectedDeliveryDate)}`;
  document.querySelector('#total-count').textContent = dayDeliveries.length.toLocaleString();
  document.querySelector('#pending-count').textContent = pendingBills.toLocaleString();
  document.querySelector('#pending-unit-copy').textContent = `${pendingUnits.toLocaleString()} ${pendingUnits === 1 ? 'unit' : 'units'} still to deliver`;
  document.querySelector('#progress-count').textContent = (count['In progress'] || 0).toLocaleString();
  document.querySelector('#completed-count').textContent = ((count.Completed || 0) + (count.Returned || 0)).toLocaleString();
  document.querySelector('#nav-count').textContent = allDayDeliveries.length > 99 ? '99+' : String(allDayDeliveries.length);
}

function visibleDeliveries() {
  const query = document.querySelector('#search-input').value.trim().toLowerCase();
  const status = document.querySelector('#status-filter').value;
  return getDeliveryAgentDeliveries().filter(bill => {
    const matchesStatus = status === 'All' || bill.status === status;
    const matchesSalesman = !selectedSalesmanFilter ||
      String(bill.salesman || '').trim().toLocaleLowerCase() === selectedSalesmanFilter.toLocaleLowerCase();
    const searchable = [bill.bill_no, bill.outlet_name, bill.address, bill.assigned_partner_name, ...bill.items.map(item => item.item_name)]
      .join(' ')
      .toLowerCase();
    return matchesSalesman && matchesStatus && (!query || searchable.includes(query));
  });
}

function renderRows() {
  const rows = document.querySelector('#delivery-rows');
  const emptyState = document.querySelector('#empty-state');
  const emptyTitle = document.querySelector('#empty-title');
  const emptyCopy = document.querySelector('#empty-copy');
  updateSalesmanOptions();
  const filtered = visibleDeliveries();
  const visibleIds = new Set(filtered.map(bill => bill.id));
  for (const billId of selectedBillIds) {
    if (!visibleIds.has(billId)) selectedBillIds.delete(billId);
  }

  document.querySelector('#result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'order' : 'orders'}`;
  document.querySelector('#table-footer-copy').textContent = `Showing ${filtered.length} ${filtered.length === 1 ? 'delivery' : 'deliveries'}`;
  document.querySelector('#panel-subtitle').textContent = currentUser?.role === 'manager'
    ? `Deliveries for ${formatDate(selectedDeliveryDate)} — assign partners and monitor their progress.`
    : currentUser?.role === 'delivery_partner'
      ? `Deliveries assigned to you for ${formatDate(selectedDeliveryDate)} — update their progress.`
      : `Deliveries for ${formatDate(selectedDeliveryDate)} — update progress and see what’s still pending.`;
  rows.innerHTML = filtered.map(bill => {
    const quantities = getQuantities(bill);
    const percentage = quantities.total ? Math.round(quantities.resolved / quantities.total * 100) : 0;
    const deliveryStatus = quantities.remaining
      ? `${quantities.remaining.toLocaleString()} ${quantities.remaining === 1 ? 'unit' : 'units'} pending`
      : 'All items resolved';
    const itemPreview = bill.items.slice(0, 2).map(item =>
      `<span>${escapeHtml(item.item_name)} · ${Number(item.qty_ordered).toLocaleString()}</span>`
    ).join('');
    const moreItems = bill.items.length > 2 ? `<span>+${bill.items.length - 2} more item${bill.items.length > 3 ? 's' : ''}</span>` : '';
    const returnedItems = bill.items.filter(item => Number(item.qty_returned) > 0);
    const returnSummary = returnedItems.map(item =>
      `<span class="return-type-summary">${Number(item.qty_returned).toLocaleString()} returned · ${escapeHtml(item.return_type || 'Type not set')}</span>`
    ).join('');

    const assignmentCell = ['admin', 'manager'].includes(currentUser?.role)
      ? `<td data-label="Delivery partner"><select class="assignment-select" data-assignment="${bill.id}" aria-label="Assign bill ${escapeHtml(bill.bill_no)}"><option value="">Unassigned</option>${deliveryPartners.map(partner => `<option value="${partner.id}" ${Number(bill.assigned_to) === partner.id ? 'selected' : ''}>${escapeHtml(partner.fullName)}</option>`).join('')}</select></td>`
      : '';
    const actionCell = currentUser?.role === 'manager'
      ? '<td data-label="Action"><span class="assignment-note">Assign a partner</span></td>'
      : `<td data-label="Action"><button class="row-action" type="button" data-reconcile="${bill.id}" aria-label="Update delivery ${escapeHtml(bill.bill_no)}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6.5 12.5 3.6 3.6 7.7-8.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/></svg>Update</button></td>`;
    const selectionCell = ['admin', 'manager'].includes(currentUser?.role)
      ? `<td data-label="Select"><input class="bill-select-checkbox" type="checkbox" data-select-bill="${bill.id}" aria-label="Select bill ${escapeHtml(bill.bill_no)}" ${selectedBillIds.has(bill.id) ? 'checked' : ''}></td>`
      : '';
    const duration = formatDuration(bill.progress_started_at, bill.completed_at || new Date());
    const timingDetails = [
      bill.progress_started_at ? `Started ${formatDateTime(bill.progress_started_at)}` : '',
      bill.progress_updated_at ? `Updated ${formatDateTime(bill.progress_updated_at)}` : '',
      duration ? `${bill.completed_at ? 'Duration' : 'Elapsed'} ${duration}` : ''
    ].filter(Boolean);
    const displayedDeliveryDate = bill.status === 'Not supplied' &&
      bill.not_supplied_from_date < selectedDeliveryDate
      ? `Carried from ${formatDate(bill.not_supplied_from_date)}`
      : formatDate(bill.delivery_date || bill.created_at);
    const salesmanDetails = bill.salesman
      ? `<span class="outlet-salesman">Salesman: ${escapeHtml(bill.salesman)}</span>`
      : '';
    return `<tr class="${bill.status === 'Completed' ? 'delivery-row-completed' : ''}">
      ${selectionCell}
      <td data-label="Delivery"><div class="bill-cell"><span class="bill-number">#${escapeHtml(bill.bill_no)}</span><span class="bill-date">${escapeHtml(displayedDeliveryDate)}</span></div></td>
      <td data-label="Outlet &amp; area"><div class="outlet-cell"><span class="outlet-name" title="${escapeHtml(bill.outlet_name)}">${escapeHtml(bill.outlet_name)}</span><span class="outlet-address" title="${escapeHtml(bill.address || 'No address listed')}">${escapeHtml(bill.address || 'No address listed')}</span>${salesmanDetails}</div></td>
      <td data-label="Items"><div class="item-summary">${itemPreview}${moreItems}${returnSummary}</div></td>
      <td class="progress-cell" data-label="Progress"><div class="progress-label"><span>${quantities.delivered.toLocaleString()} / ${quantities.total.toLocaleString()} delivered</span><strong>${percentage}%</strong></div><div class="progress-track" aria-label="${percentage}% resolved, ${escapeHtml(deliveryStatus)}"><div class="progress-bar" style="width:${percentage}%"></div></div><span class="progress-pending">${escapeHtml(deliveryStatus)}</span></td>
      <td data-label="Status"><div class="status-details"><span class="status-pill ${statusClass(bill.status)}">${escapeHtml(bill.status)}</span>${timingDetails.map(detail => `<span class="status-time">${escapeHtml(detail)}</span>`).join('')}</div></td>
      ${assignmentCell}${actionCell}
    </tr>`;
  }).join('');
  updateBulkAssignmentControls(filtered);

  const showEmpty = filtered.length === 0;
  emptyState.hidden = !showEmpty;
  if (showEmpty) {
    const noData = getSelectedDayDeliveries().length === 0;
    const hasAnyDeliveries = deliveries.length > 0;
    emptyTitle.textContent = noData
      ? currentUser?.role === 'delivery_partner' ? 'No deliveries assigned yet' : 'Your delivery list is ready'
      : 'No matching deliveries';
    emptyCopy.textContent = noData
      ? hasAnyDeliveries
        ? `There are no deliveries for ${formatDate(selectedDeliveryDate)}. Choose another date or import a sales file for this day.`
        : currentUser?.role === 'delivery_partner'
          ? 'Your manager will assign deliveries to your account.'
          : 'Import an Excel or CSV file to start tracking your orders.'
      : 'Try another search, status, or delivery agent filter.';
    document.querySelector('#empty-upload').hidden = currentUser?.role === 'delivery_partner' || !noData || hasAnyDeliveries;
  }

  updateSummary();
}

async function loadDeliveries() {
  const result = await requestJson('/api/bills');
  if (!Array.isArray(result)) {
    throw new Error('The server returned an unexpected delivery list.');
  }
  deliveries = result;
  const savedDate = localStorage.getItem('tafDistiDesk.selectedDeliveryDate');
  const today = getLocalDateValue();
  const hasActiveCarryover = deliveries.some(bill =>
    bill.status === 'Not supplied' &&
    /^\d{4}-\d{2}-\d{2}$/.test(bill.not_supplied_from_date || '') &&
    bill.not_supplied_from_date <= today
  );
  if (!hasInitializedDeliveryDate && hasActiveCarryover && /^\d{4}-\d{2}-\d{2}$/.test(savedDate || '') && savedDate < today) {
    selectedDeliveryDate = today;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(savedDate || '')) {
    selectedDeliveryDate = savedDate;
  } else {
    const availableDates = deliveries.map(getBillDeliveryDate).filter(Boolean).sort();
    selectedDeliveryDate = hasActiveCarryover
      ? today
      : availableDates.filter(date => date <= today).pop() || today;
  }
  hasInitializedDeliveryDate = true;
  document.querySelector('#dashboard-date').value = selectedDeliveryDate;
  renderRows();
}

async function loadCurrentUser() {
  const result = await requestJson('/api/auth/session');
  const user = result.user;
  if (!user) {
    window.location.assign('/login');
    throw new Error('Your session has expired. Please sign in again.');
  }

  currentUser = user;
  document.querySelector('#profile-name').textContent = user.fullName;
  document.querySelector('#profile-role').textContent = {
    admin: 'Admin',
    manager: 'Manager',
    delivery_partner: 'Delivery Partner'
  }[user.role] || user.position;
  const initial = user.fullName.trim().charAt(0).toUpperCase() || 'U';
  document.querySelector('#profile-avatar').textContent = initial;
  document.querySelector('#top-profile-avatar').textContent = initial;
  document.querySelector('#top-profile-avatar').setAttribute('aria-label', `Sign out ${user.fullName}`);
  document.querySelector('#user-management-link').hidden = user.role !== 'admin';
  document.querySelector('#profitability-link').hidden = user.role === 'delivery_partner';
  document.querySelector('#at-stock-link').hidden = !['admin', 'manager'].includes(user.role);
  document.querySelector('#open-upload').hidden = user.role === 'delivery_partner';
  document.querySelector('#download-template').hidden = user.role === 'delivery_partner';
  document.querySelector('#modal-template').hidden = user.role === 'delivery_partner';
  exportButton.hidden = user.role === 'delivery_partner';
  document.querySelector('#assigned-header').hidden = !['admin', 'manager'].includes(user.role);
  document.querySelector('#delivery-agent-filter-control').hidden = !['admin', 'manager'].includes(user.role);
  document.querySelector('#bulk-assignment').hidden = !['admin', 'manager'].includes(user.role);
  document.querySelector('#bulk-select-header').hidden = !['admin', 'manager'].includes(user.role);
  document.querySelector('#delivery-heading').textContent = user.role === 'delivery_partner' ? 'My assigned deliveries' : 'All deliveries';
  document.querySelector('#total-copy').textContent = user.role === 'delivery_partner'
    ? 'Bills assigned to you'
    : user.role === 'manager'
      ? 'All imported orders to assign'
      : 'All imported orders';
  document.querySelector('#page-heading-title').textContent = user.role === 'delivery_partner'
    ? 'Your assigned deliveries'
    : 'Your deliveries, in one place.';
  document.querySelector('#page-heading-copy').textContent = user.role === 'manager'
    ? 'Select multiple bills and assign them to a delivery partner together.'
    : user.role === 'delivery_partner'
      ? 'Update delivery progress for the bills assigned to you.'
      : 'Import your order sheet and keep every drop-off on track.';
  document.querySelector('#panel-subtitle').textContent = user.role === 'manager'
    ? 'Select one or more bills below to assign them to a delivery partner.'
    : user.role === 'delivery_partner'
      ? 'Only deliveries assigned to your account are shown.'
      : 'View orders and update delivery progress for the selected day.';
  document.querySelector('#empty-upload').hidden = user.role === 'delivery_partner';
  initializeProfitabilityDates();
  initializeAtStockInterface();
  showDashboardPage('deliveries');
  renderRows();
}

async function loadDeliveryPartners() {
  if (!['admin', 'manager'].includes(currentUser?.role)) return;
  deliveryPartners = await requestJson('/api/delivery-partners');
  document.querySelector('#bulk-partner-select').innerHTML = '<option value="">Choose a delivery partner</option>' +
    deliveryPartners.map(partner => `<option value="${partner.id}">${escapeHtml(partner.fullName)}</option>`).join('');
  document.querySelector('#delivery-agent-filter').innerHTML =
    '<option value="">All delivery agents</option><option value="unassigned">Unassigned</option>' +
    deliveryPartners.map(partner => `<option value="${partner.id}">${escapeHtml(partner.fullName)}</option>`).join('');
}

function initializeProfitabilityDates() {
  const today = getLocalDateValue();
  document.querySelector('#profit-date').value = today;
  document.querySelector('#rfa-from-date').value = `${today.slice(0, 7)}-01`;
  document.querySelector('#rfa-to-date').value = today;
}

function initializeAtStockInterface() {
  if (document.querySelector('#profitability-at-stock-report')) return;

  const panel = document.createElement('section');
  panel.className = 'profitability-panel at-stock-report';
  panel.id = 'profitability-at-stock-report';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="at-stock-heading">
      <div><h3>AT stock</h3><p id="at-stock-date-label"></p></div>
      <div class="at-stock-actions"><button class="button button-secondary" id="export-at-stock" type="button">Export Excel</button><button class="button button-primary" id="save-at-stock" type="button">Save stock changes</button></div>
    </div>
    <div class="dialog-error" id="at-stock-error" role="alert" hidden></div>
    <div class="at-stock-table-wrap">
      <table class="at-stock-table">
        <thead><tr><th>Category</th><th>Product</th><th>Opening</th><th>Sales</th><th>Sales return</th><th>Purchase</th><th>Damaged</th><th>Closing</th><th>Tallied</th></tr></thead>
        <tbody id="at-stock-rows"></tbody>
      </table>
    </div>
    <p class="at-stock-empty" id="at-stock-empty" hidden>No AT or BC products are available. Upload a sales register to populate this list.</p>
    <p class="at-stock-note">AT quantities use 30 kg stock bags and loose packs; pack weight is read from the item name. BC quantities are in pieces. Sales and sales returns update from the uploaded sales register.</p>
    <p class="at-stock-save-status" id="at-stock-save-status" role="status"></p>`;
  const controls = document.querySelector('.profitability-controls');
  const tabs = document.createElement('div');
  tabs.className = 'profitability-tabs';
  tabs.id = 'at-bc-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'AT and BC sections');
  tabs.hidden = true;
  tabs.innerHTML = '<button class="profitability-tab" type="button" role="tab" data-at-tab="at-stock">Stock</button><button class="profitability-tab" type="button" role="tab" data-at-tab="at-assignment">Assignment</button><button class="profitability-tab" type="button" role="tab" data-at-tab="at-damages">Damages</button>';
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-at-tab]');
    if (!tab) return;
    showDashboardPage(tab.dataset.atTab);
    if (tab.dataset.atTab === 'at-stock') loadAtStockReport();
    else if (tab.dataset.atTab === 'at-assignment') loadAtAssignmentReport();
    else loadAtDamages();
  });
  controls.insertAdjacentElement('beforebegin', tabs);
  controls.insertAdjacentElement('afterend', panel);
  document.querySelector('#save-at-stock').addEventListener('click', saveAtStock);
  document.querySelector('#at-stock-rows').addEventListener('click', toggleAtTallied);
  panel.addEventListener('click', event => { if (event.target.closest('[data-assignment-toggle]')) toggleAtAssignment(event); });

  const assignment = document.createElement('section');
  assignment.className = 'profitability-panel at-assignment-report';
  assignment.id = 'profitability-at-assignment-report';
  assignment.hidden = true;
  assignment.innerHTML = `
    <div class="at-stock-heading">
      <div><h3>AT and BC assignment by delivery agent</h3><p id="at-assignment-date-label"></p></div>
      <button class="button button-secondary" id="export-at-assignment" type="button">Export Excel</button>
    </div>
    <div class="dialog-error" id="at-assignment-error" role="alert" hidden></div>
    <div id="at-assignment-agents"></div>
    <p class="at-stock-empty" id="at-assignment-empty" hidden>No AT or BC sales are available for this date.</p>
    <p class="at-stock-note">Quantities come from the uploaded sales register and follow the delivery assignments made under Deliveries. Bags are 30 kg each.</p>`;
  panel.insertAdjacentElement('afterend', assignment);

  for (const [id, path, name] of [['#export-at-stock', 'at-stock', 'AT-Stock'], ['#export-at-assignment', 'at-assignment', 'AT-Assignment']]) {
    document.querySelector(id).addEventListener('click', () => {
      const date = document.querySelector('#profit-date').value;
      if (!date) return showToast('Choose a date before exporting.', true);
      downloadExcelReport(`/api/profitability/${path}?date=${encodeURIComponent(date)}&format=xlsx`, `${name}-${date}.xlsx`, document.querySelector(id));
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const damages = document.createElement('section');
  damages.className = 'profitability-panel at-damages-report';
  damages.id = 'profitability-at-damages-report';
  damages.hidden = true;
  damages.innerHTML = `
    <div class="at-stock-heading">
      <div><h3>AT and BC damaged stock</h3><p>Stock moved to damaged from the AT Stock page.</p></div>
      <div class="at-stock-actions">
        <label>From <input type="date" id="at-damages-from" value="${today.slice(0, 8)}01"></label>
        <label>To <input type="date" id="at-damages-to" value="${today}"></label>
        <button class="button button-secondary" id="export-at-damages" type="button">Export Excel</button>
      </div>
    </div>
    <div class="dialog-error" id="at-damages-error" role="alert" hidden></div>
    <div class="at-stock-table-wrap">
      <table class="at-stock-table">
        <thead><tr><th>Date</th><th>Category</th><th>Product</th><th>Damaged quantity</th></tr></thead>
        <tbody id="at-damages-rows"></tbody>
      </table>
    </div>
    <p class="at-stock-empty" id="at-damages-empty" hidden>No damaged stock was recorded in this period.</p>`;
  assignment.insertAdjacentElement('afterend', damages);
  document.querySelector('#at-damages-from').addEventListener('change', loadAtDamages);
  document.querySelector('#at-damages-to').addEventListener('change', loadAtDamages);
  document.querySelector('#export-at-damages').addEventListener('click', () => {
    const from = document.querySelector('#at-damages-from').value;
    const to = document.querySelector('#at-damages-to').value;
    if (!from || !to) return showToast('Choose from and to dates before exporting.', true);
    downloadExcelReport(`/api/profitability/damages?${new URLSearchParams({ fromDate: from, toDate: to, format: 'xlsx' })}`, `Damages-${from}-to-${to}.xlsx`, document.querySelector('#export-at-damages'));
  });
}

async function loadAtDamages() {
  const from = document.querySelector('#at-damages-from').value;
  const to = document.querySelector('#at-damages-to').value;
  const errorElement = document.querySelector('#at-damages-error');
  errorElement.hidden = true;
  if (!from || !to) return;
  try {
    const report = await requestJson(`/api/profitability/damages?${new URLSearchParams({ fromDate: from, toDate: to })}`);
    document.querySelector('#at-damages-empty').hidden = report.entries.length > 0;
    document.querySelector('#at-damages-rows').innerHTML = report.entries.map(entry => `<tr>
      <td data-label="Date">${formatDate(entry.date)}</td>
      <td data-label="Category">${entry.category}</td>
      <td data-label="Product" title="${escapeHtml(entry.itemName)}">${escapeHtml(entry.displayName)}</td>
      <td data-label="Damaged quantity">${entry.display ? escapeHtml(entry.display) : `${formatStockNumber(entry.quantity)} kg`}</td>
    </tr>`).join('');
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

async function toggleAtTallied(event) {
  const button = event.target.closest('[data-stock-tallied]');
  if (!button) return;
  const row = button.closest('tr');
  const tallied = button.dataset.stockTallied !== '1';
  button.disabled = true;
  try {
    const date = document.querySelector('#profit-date').value;
    await requestJson(`/api/profitability/at-stock/${encodeURIComponent(date)}    /tallied`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: row.dataset.stockCategory,
        itemCode: row.dataset.stockCode,
        itemName: row.dataset.stockName,
            tallied
      })
    });
        await loadAtStockReport();
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    }

    async function toggleAtAssignment(event) {
      const button = event.target.closest('[data-assignment-toggle]');
      const assigned = button.dataset.assignmentToggle !== '1';
      button.disabled = true;
      try {
        const date = document.querySelector('#profit-date').value;
        await requestJson(`/api/profitability/at-assignment/${encodeURIComponent(date)}/assigned`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: button.dataset.agentId ? Number(button.dataset.agentId) : null,
            category: button.dataset.category,
            itemCode: button.dataset.itemCode,
            itemName: button.dataset.itemName,
            assigned
          })
        });
        await loadAtAssignmentReport();
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    }

async function loadAtAssignmentReport() {
  const selectedDate = document.querySelector('#profit-date').value;
  const errorElement = document.querySelector('#at-assignment-error');
  errorElement.hidden = true;
  if (!selectedDate) return;
  try {
    const report = await requestJson(`/api/profitability/at-assignment?${new URLSearchParams({ date: selectedDate })}`);
    document.querySelector('#at-assignment-date-label').textContent = `Sales for ${formatDate(report.date)}`;
    document.querySelector('#at-assignment-empty').hidden = report.agents.length > 0;
    document.querySelector('#at-assignment-agents').innerHTML = report.agents.map(agent => `
      <article class="at-assignment-agent">
        <h4>${escapeHtml(agent.agentName)}</h4>
        <div class="at-stock-table-wrap"><table class="at-stock-table">
          <thead><tr><th>Category</th><th>Product</th><th>Quantity</th><th>Bills</th><th>Assigned</th></tr></thead>
          <tbody>${agent.items.map(item => `<tr>
            <td data-label="Category">${item.category}</td>
            <td data-label="Product" title="${escapeHtml(item.itemName)}">${escapeHtml(item.displayName)}</td>
            <td data-label="Quantity">${item.packWeightKg
              ? formatAtStockQuantity(item.quantity * item.packWeightKg, item.packWeightKg)
              : `${formatStockNumber(item.quantity)} pcs`}</td>
            <td data-label="Bills">${item.billCount}</td>
            <td data-label="Assigned"><button class="button at-stock-assigned${item.assigned ? ' is-assigned' : ''}" type="button" data-assignment-toggle="${item.assigned ? '1' : '0'}" data-agent-id="${agent.agentId ?? ''}" data-category="${item.category}" data-item-code="${escapeHtml(item.itemCode)}" data-item-name="${escapeHtml(item.itemName)}" aria-pressed="${item.assigned}" ${item.locked && currentUser?.role !== 'admin' ? 'disabled title="Assigned and tallied. Only an administrator can change this."' : ''}>${item.assigned ? 'Assigned \u2713' : 'Assigned'}</button></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </article>`).join('');
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

function showProfitabilityTab(tab) {
  const activeTab = tab === 'rfa' ? 'rfa' : 'sku';
  document.querySelector('#profitability-sku-report').hidden = activeTab !== 'sku';
  document.querySelector('#profitability-rfa-report').hidden = activeTab !== 'rfa';
  document.querySelector('#profitability-sku-tab-button').classList.toggle('active', activeTab === 'sku');
  document.querySelector('#profitability-rfa-tab-button').classList.toggle('active', activeTab === 'rfa');
  document.querySelector('#profitability-sku-tab-button').setAttribute('aria-selected', String(activeTab === 'sku'));
  document.querySelector('#profitability-rfa-tab-button').setAttribute('aria-selected', String(activeTab === 'rfa'));
  if (activeTab === 'rfa') loadRfaReport();
}

function formatStockNumber(value) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value);
}

function getBagAndPieceCounts(quantityKg, packWeightKg) {
  const bags = Math.trunc((quantityKg + Number.EPSILON) / 30);
  const loosePieces = Math.round((quantityKg - bags * 30) / packWeightKg);
  return { bags, loosePieces };
}

function formatAtStockQuantity(quantityKg, packWeightKg) {
  if (!packWeightKg) return 'Pack size missing';
  const { bags, loosePieces } = getBagAndPieceCounts(quantityKg, packWeightKg);
  return `${formatStockNumber(bags)} bags, ${formatStockNumber(loosePieces)} pcs`;
}

function renderStockEntryInputs(row, field, baseQuantity, editable) {
  const disabled = !editable || (row.category === 'AT' && !row.packWeightKg);
  if (row.category === 'BC') {
    return `<label class="at-stock-input"><span class="visually-hidden">${field} pieces for ${escapeHtml(row.itemName)}</span>
      <input type="number" min="0" step="any" data-stock-${field}-pcs value="${formatStockNumber(baseQuantity)}" ${disabled ? 'disabled' : ''}>
      <span>pcs</span></label>`;
  }
  if (!row.packWeightKg) return '<span class="at-stock-missing-pack">Add kg pack size to item name</span>';
  if (row.packWeightKg >= 5) {
    return `<div class="at-stock-units">
    <label class="at-stock-input"><span class="visually-hidden">${field} pieces for ${escapeHtml(row.itemName)}</span>
      <input type="number" min="0" step="any" data-stock-${field}-pcs value="${formatStockNumber(Math.round(baseQuantity / row.packWeightKg * 100) / 100)}" ${disabled ? 'disabled' : ''}>
      <span>pcs</span></label>
  </div>`;
  }
  const count = getBagAndPieceCounts(baseQuantity, row.packWeightKg);
  return `<div class="at-stock-units">
    <label class="at-stock-input"><span class="visually-hidden">${field} 30 kg bags for ${escapeHtml(row.itemName)}</span>
      <input type="number" min="0" step="any" data-stock-${field}-bags value="${formatStockNumber(count.bags)}" ${disabled ? 'disabled' : ''}>
      <span>bags</span></label>
    <label class="at-stock-input"><span class="visually-hidden">${field} pieces for ${escapeHtml(row.itemName)}</span>
      <input type="number" min="0" step="any" data-stock-${field}-pcs value="${formatStockNumber(count.loosePieces)}" ${disabled ? 'disabled' : ''}>
      <span>pcs</span></label>
  </div>`;
}

function renderAtStockReport(report) {
  const canEditOpening = currentUser?.role === 'admin';
  const canEditPurchases = ['admin', 'manager'].includes(currentUser?.role);
  const missingPackNames = report.rows
    .filter(row => row.category === 'AT' && !row.packWeightKg)
    .map(row => row.itemName);
  const rows = report.rows.map(row => {
  const canEditRow = canEditPurchases && (!row.locked || currentUser?.role === 'admin');
  const lockedForUser = row.locked && currentUser?.role !== 'admin';
  return `<tr data-stock-category="${escapeHtml(row.category)}"
    data-stock-code="${escapeHtml(row.itemCode)}" data-stock-name="${escapeHtml(row.itemName)}"
    data-stock-pack-weight="${row.packWeightKg || ''}">
    <td data-label="Category">${escapeHtml(row.category)}</td>
    <td data-label="Product" title="${escapeHtml(row.itemName)}">${escapeHtml(row.displayName || row.itemName)}</td>
    <td data-label="Opening">${renderStockEntryInputs(row, 'opening', row.openingQty, canEditOpening)}</td>
    <td data-label="Sales">${row.category === 'AT' ? formatAtStockQuantity(row.salesQty, row.packWeightKg) : `${formatStockNumber(row.salesQty)} pcs`}</td>
    <td data-label="Sales return">${row.category === 'AT' ? formatAtStockQuantity(row.returnQty, row.packWeightKg) : `${formatStockNumber(row.returnQty)} pcs`}</td>
    <td data-label="Purchase">${renderStockEntryInputs(row, 'purchase', row.purchaseQty, canEditRow)}</td>
    <td data-label="Damaged">${renderStockEntryInputs(row, 'damaged', row.damagedQty, canEditRow)}</td>
    <td data-label="Closing">${row.category === 'AT' ? formatAtStockQuantity(row.closingQty, row.packWeightKg) : `${formatStockNumber(row.closingQty)} pcs`}</td>
    <td data-label="Tallied"><button class="button at-stock-assigned${row.tallied ? ' is-assigned' : ''}" type="button" data-stock-tallied="${row.tallied ? '1' : '0'}" aria-pressed="${row.tallied}" ${lockedForUser ? 'disabled title="Assigned and tallied. Only an administrator can change this."' : ''}>${row.tallied ? 'Tallied ✓' : 'Tallied'}</button></td>
  </tr>`;}).join('');
  document.querySelector('#at-stock-rows').innerHTML = rows;
  document.querySelector('#at-stock-empty').hidden = report.rows.length > 0;
  document.querySelector('#at-stock-date-label').textContent = `Stock for ${formatDate(report.date)}`;
  document.querySelector('#save-at-stock').hidden = !canEditOpening && !canEditPurchases;
  document.querySelector('#save-at-stock').disabled = false;
  const errorElement = document.querySelector('#at-stock-error');
  errorElement.hidden = missingPackNames.length === 0;
  errorElement.textContent = missingPackNames.length
    ? `AT item names need a pack size such as 1 kg, 5 kg, or 10 kg: ${missingPackNames.join(', ')}.`
    : '';
  document.querySelector('#at-stock-save-status').textContent = '';
  document.querySelector('#at-stock-save-status').classList.remove('error');
}

async function loadAtStockReport() {
  const selectedDate = document.querySelector('#profit-date').value;
  const errorElement = document.querySelector('#at-stock-error');
  errorElement.hidden = true;
  if (!selectedDate) {
    errorElement.textContent = 'Choose a valid stock date.';
    errorElement.hidden = false;
    return;
  }
  try {
    const query = new URLSearchParams({ date: selectedDate });
    renderAtStockReport(await requestJson(`/api/profitability/at-stock?${query}`));
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

async function saveAtStock() {
  const rows = [...document.querySelectorAll('#at-stock-rows tr[data-stock-category]')];
  const entries = rows.filter(row => row.dataset.stockCategory !== 'AT' || Number(row.dataset.stockPackWeight) > 0).map(row => {
    const category = row.dataset.stockCategory;
    const weight = Number(row.dataset.stockPackWeight);
    const readInput = selector => {
      const value = row.querySelector(selector).value;
      return value === '' ? NaN : Number(value);
    };
    const getQuantity = field => category === 'AT'
      ? (row.querySelector(`[data-stock-${field}-bags]`) ? readInput(`[data-stock-${field}-bags]`) * 30 : 0) +
        readInput(`[data-stock-${field}-pcs]`) * weight
      : readInput(`[data-stock-${field}-pcs]`);
    return {
      category,
      itemCode: row.dataset.stockCode,
      itemName: row.dataset.stockName,
      openingQty: currentUser.role === 'admin' ? getQuantity('opening') : null,
      purchaseQty: getQuantity('purchase'),
      damagedQty: getQuantity('damaged')
    };
  });
  if (!entries.length) {
    document.querySelector('#at-stock-save-status').textContent = 'There are no stock rows to save.';
    return;
  }
  const status = document.querySelector('#at-stock-save-status');
  const button = document.querySelector('#save-at-stock');
  button.disabled = true;
  status.textContent = 'Saving...';
  status.classList.remove('error');
  try {
    const date = document.querySelector('#profit-date').value;
    const result = await requestJson(`/api/profitability/at-stock/${encodeURIComponent(date)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries })
    });
    showToast(result.message);
    await loadAtStockReport();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    button.disabled = false;
  }
}

function renderRfaReport(report) {
  document.querySelector('#rfa-report-total').textContent = formatCurrency(report.totalNetRfa);
  document.querySelector('#rfa-report-date').textContent =
    `RFA from ${formatDate(report.fromDate)} to ${formatDate(report.toDate)}`;
  const rows = document.querySelector('#rfa-report-rows');
  rows.innerHTML = report.rows.map(row => `<tr>
    <td data-label="Category">${escapeHtml(row.category)}</td>
    <td data-label="Net RFA due">${formatCurrency(row.netRfa)}</td>
  </tr>`).join('');
  document.querySelector('#rfa-report-empty').hidden = report.rows.length > 0;
}

async function loadRfaReport() {
  const fromDate = document.querySelector('#rfa-from-date').value;
  const toDate = document.querySelector('#rfa-to-date').value;
  const errorElement = document.querySelector('#rfa-report-error');
  errorElement.hidden = true;
  if (!fromDate || !toDate) {
    errorElement.textContent = 'Choose both a from date and a to date.';
    errorElement.hidden = false;
    return;
  }
  if (fromDate > toDate) {
    errorElement.textContent = 'The from date must be on or before the to date.';
    errorElement.hidden = false;
    return;
  }
  try {
    const query = new URLSearchParams({ fromDate, toDate });
    renderRfaReport(await requestJson(`/api/profitability/rfa-report?${query}`));
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

function renderProfitabilityReport(report) {
  const { summary, items, excludedItems = [] } = report;
  const missingCosts = summary.missingCostItems.length > 0 || summary.missingQuantityItems.length > 0;
  document.querySelector('#profit-gross').textContent = formatCurrency(summary.grossAmount);
  document.querySelector('#profit-cogs').textContent = missingCosts ? 'Incomplete' : formatCurrency(summary.cogs);
  document.querySelector('#profit-without-rfa').textContent = missingCosts ? 'Incomplete' : formatCurrency(summary.netProfitWithoutRfa);
  document.querySelector('#profit-with-rfa').textContent = missingCosts ? 'Incomplete' : formatCurrency(summary.netProfitWithRfa);
  document.querySelector('#profit-rfa').textContent = formatCurrency(summary.rfaAmount);
  document.querySelector('#profit-output-gst').textContent = formatCurrency(summary.outputTax);
  document.querySelector('#profit-input-gst').textContent = missingCosts ? 'Incomplete' : formatCurrency(summary.inputGst);
  document.querySelector('#profit-gst-payable').textContent = missingCosts ? 'Incomplete' : formatCurrency(summary.gstPayable);

  const warning = document.querySelector('#profitability-warning');
  const warningMessages = [];
  if (missingCosts) {
    if (summary.missingCostItems.length) {
      warningMessages.push(`Profit is incomplete because no backend purchase cost matched these items: ${summary.missingCostItems.join(', ')}.`);
    }
    if (summary.missingQuantityItems.length) {
      warningMessages.push(`Purchase cost cannot be calculated for these sales lines because both invoice quantity and sales return quantity are zero: ${summary.missingQuantityItems.join(', ')}.`);
    }
  }
  if (excludedItems.length) {
    warningMessages.push(`Excluded from this date's report: ${excludedItems.join(', ')}.`);
  }
  warning.hidden = warningMessages.length === 0;
  warning.textContent = warningMessages.join(' ');

  const rows = document.querySelector('#profitability-rows');
  rows.innerHTML = items.map(item => {
    return `<tr>
    <td data-label="Bill No.">${escapeHtml(item.billNo)}</td>
    <td data-label="SKU Code">${escapeHtml(item.itemCode || '—')}</td>
    <td data-label="SKU Name">${escapeHtml(item.itemName || '—')}</td>
    <td data-label="Net purchase cost · pre-tax">${item.missingQuantity ? 'Qty unavailable' : item.missingCost ? 'Cost missing' : formatCurrency(item.purchaseCost)}</td>
    <td data-label="Net selling cost · pre-tax">${formatCurrency(item.netSellingCost)}</td>
    <td data-label="GST payable">${item.missingQuantity ? 'Qty unavailable' : item.missingCost ? 'Cost missing' : formatCurrency(item.gstPayable)}</td>
    <td data-label="Net margin before RFA">${item.missingQuantity ? 'Qty unavailable' : item.missingCost ? 'Cost missing' : item.netMarginBeforeRfa === null ? '—' : `${item.netMarginBeforeRfa.toFixed(2)}%`}</td>
    <td data-label="RFA amount">${formatCurrency(item.rfaAmount)}</td>
    <td data-label="Net margin after RFA">${item.missingQuantity ? 'Qty unavailable' : item.missingCost ? 'Cost missing' : item.netMarginAfterRfa === null ? '—' : `${item.netMarginAfterRfa.toFixed(2)}%`}</td>
    </tr>`;
  }).join('');
  document.querySelector('#profitability-empty').hidden = items.length > 0;
}

async function loadProfitabilityReport() {
  const selectedDate = document.querySelector('#profit-date').value;
  const errorElement = document.querySelector('#profitability-error');
  errorElement.hidden = true;
  if (!selectedDate) {
    errorElement.textContent = 'Choose a valid profitability date.';
    errorElement.hidden = false;
    return;
  }

  try {
    const query = new URLSearchParams({ date: selectedDate });
    const report = await requestJson(`/api/profitability/report?${query}`);
    renderProfitabilityReport(report);
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

async function uploadProfitabilityFile(file) {
  if (!file) return;
  const input = document.querySelector('#profit-sales-file');
  const button = document.querySelector('#import-profit-sales');
  const status = document.querySelector('#profit-sales-status');
  const selectedDate = document.querySelector('#profit-date').value;
  if (!selectedDate) {
    status.textContent = 'Choose a profitability date before uploading.';
    status.classList.add('error');
    input.value = '';
    return;
  }
  status.textContent = 'Uploading…';
  status.classList.remove('error');
  button.disabled = true;
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('deliveryDate', selectedDate);
    const result = await requestJson('/api/profitability/sales', {
      method: 'POST',
      body: formData
    });
    status.textContent = result.message;
    if (currentUser.role === 'admin') {
      await loadProfitabilityReport();
      await loadRfaReport();
    }
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    button.disabled = false;
    input.value = '';
  }
}

async function uploadProfitabilityCostsFile(file) {
  if (!file) return;
  const input = document.querySelector('#profit-costs-file');
  const button = document.querySelector('#import-profit-costs');
  const status = document.querySelector('#profit-costs-status');
  status.textContent = 'Uploading…';
  status.classList.remove('error');
  button.disabled = true;
  try {
    const formData = new FormData();
    formData.append('file', file);
    const result = await requestJson('/api/profitability/product-costs', {
      method: 'POST',
      body: formData
    });
    status.textContent = result.message;
    await loadProfitabilityReport();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    button.disabled = false;
    input.value = '';
  }
}

function showDashboardPage(page) {
  const isAdmin = currentUser?.role === 'admin';
  const isAtStock = page === 'at-stock' && ['admin', 'manager'].includes(currentUser?.role);
  const isAtAssignment = page === 'at-assignment' && ['admin', 'manager'].includes(currentUser?.role);
  const isManagerUpload = page === 'profitability' && currentUser?.role === 'manager';
  const isProfitability = page === 'profitability' && (isAdmin || isManagerUpload);
  const isAtDamages = page === 'at-damages' && ['admin', 'manager'].includes(currentUser?.role);
  const isAtArea = isAtStock || isAtAssignment || isAtDamages;
  const isProfitabilityArea = isProfitability || isAtArea;
  document.querySelector('#overview').hidden = isProfitabilityArea;
  document.querySelector('#profitability').hidden = !isProfitabilityArea;
  document.querySelector('#profitability-at-stock-report').hidden = !isAtStock;
  document.querySelector('#profitability-at-assignment-report').hidden = !isAtAssignment;
  document.querySelector('#profitability-at-damages-report').hidden = !isAtDamages;
  document.querySelector('.profitability-controls').hidden = isAtDamages;
  const atTabs = document.querySelector('#at-bc-tabs');
  atTabs.hidden = !isAtArea;
  atTabs.querySelectorAll('[data-at-tab]').forEach(tab => {
    const active = tab.dataset.atTab === page;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelector('.profitability-tabs:not(#at-bc-tabs)').hidden = isAtArea || isManagerUpload;
  document.querySelector('#profitability-sku-report').hidden = isAtArea;
  document.querySelector('#profitability-sku-report > .profitability-panel').hidden = isManagerUpload;
  document.querySelector('#profitability-sku-report > .page-footer').hidden = isManagerUpload;
  document.querySelector('#import-profit-costs').closest('.profitability-import-card').hidden = isManagerUpload;
  document.querySelector('#profitability-rfa-report').hidden = isAtArea || isManagerUpload || document.querySelector('#profitability-rfa-tab-button').getAttribute('aria-selected') !== 'true';
  document.querySelector('.day-picker').hidden = isProfitabilityArea;
  exportButton.hidden = isProfitabilityArea || currentUser?.role === 'delivery_partner';
  document.querySelector('.breadcrumbs strong').textContent =
    isAtArea ? 'AT & BC' : isProfitability ? 'Profitability' : 'Deliveries';
  const profitabilityHeading = document.querySelector('#profitability .page-heading h1');
  profitabilityHeading.innerHTML = isManagerUpload ? 'Sales register <span>upload.</span>' : isAtDamages ? 'AT Damages <span>register.</span>' : isAtAssignment ? 'AT Assignment <span>by agent.</span>' : isAtStock ? 'AT Stock <span>management.</span>' : 'Profitability <span>reports.</span>';
  document.querySelector('#profitability .page-heading .eyebrow').innerHTML = isAtArea
    ? '<span class="eyebrow-dot"></span> INVENTORY MANAGEMENT'
    : isManagerUpload ? '<span class="eyebrow-dot"></span> SALES REGISTER UPLOAD'
    : '<span class="eyebrow-dot"></span> ADMIN ONLY · FINANCIAL REPORTING';
  document.querySelector('#profitability .page-heading .page-subtitle').textContent = isAtDamages
    ? 'Every AT and BC item moved to damaged, kept separate from live stock.'
    : isAtAssignment
    ? 'See which delivery agent needs which AT and BC items, based on the sales register and Deliveries assignments.'
    : isAtStock
    ? 'Track opening stock, sales, returns, purchases, and closing stock for AT and BC products.'
    : isManagerUpload ? 'Upload the daily sales register so AT stock and assignments stay up to date.'
    : 'Review SKU profitability and net RFA due from the company.';
  document.querySelector('.profitability-date-help').textContent = isAtArea
    ? 'Select the date for the stock balance.'
    : 'This date applies to SKU profitability and the sales-register upload.';
  document.querySelectorAll('.side-nav .nav-link[href^="#"]').forEach(link => {
    const isActive = link.id === 'profitability-link'
      ? isProfitability
      : link.id === 'at-stock-link'
        ? isAtArea
        : link.id === 'deliveries-link'
          ? !isProfitabilityArea
          : false;
    link.classList.toggle('active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function updateSalesmanOptions() {
  const select = document.querySelector('#bulk-salesman-select');
  const currentValue = select.value;
  const salesmen = new Map();
  for (const bill of getSelectedDayDeliveries()) {
    const name = String(bill.salesman || '').trim();
    if (name && !salesmen.has(name.toLocaleLowerCase())) {
      salesmen.set(name.toLocaleLowerCase(), name);
    }
  }

  const placeholder = salesmen.size ? 'Filter by salesman' : 'No salesman names for this date';
  select.innerHTML = `<option value="">${placeholder}</option>` +
    [...salesmen.values()]
      .sort((left, right) => left.localeCompare(right))
      .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join('');
  if ([...salesmen.values()].some(name => name.toLocaleLowerCase() === currentValue.toLocaleLowerCase())) {
    select.value = currentValue;
  } else {
    selectedSalesmanFilter = '';
  }
  selectedSalesmanFilter = select.value.trim();
  document.querySelector('#select-salesman-outlets').disabled = !select.value;
}

function selectSalesmanOutlets() {
  const salesman = document.querySelector('#bulk-salesman-select').value.trim();
  if (!salesman) return;

  const matchingBills = getSelectedDayDeliveries().filter(bill =>
    String(bill.salesman || '').trim().toLocaleLowerCase() === salesman.toLocaleLowerCase()
  );
  if (!matchingBills.length) {
    showToast(`No outlets are mapped to ${salesman} for ${formatDate(selectedDeliveryDate)}.`, true);
    return;
  }

  selectedSalesmanFilter = salesman;
  selectedBillIds.clear();
  document.querySelector('#search-input').value = '';
  document.querySelector('#status-filter').value = 'All';
  for (const bill of matchingBills) selectedBillIds.add(bill.id);
  renderRows();

  const outletCount = new Set(matchingBills.map(bill => String(bill.outlet_name).trim().toLocaleLowerCase())).size;
  showToast(`Selected ${outletCount} ${outletCount === 1 ? 'outlet' : 'outlets'} across ${matchingBills.length} bills for ${salesman}. Choose a delivery partner to assign them.`);
}

function updateBulkAssignmentControls(visibleBills = visibleDeliveries()) {
  const visibleIds = visibleBills.map(bill => bill.id);
  const selectedVisibleCount = visibleIds.filter(id => selectedBillIds.has(id)).length;
  document.querySelector('#bulk-selection-count').textContent =
    `${selectedBillIds.size} ${selectedBillIds.size === 1 ? 'bill' : 'bills'} selected`;
  const selectVisible = document.querySelector('#select-visible-bills');
  selectVisible.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  selectVisible.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  document.querySelector('#assign-selected-bills').disabled =
    selectedBillIds.size === 0 || !document.querySelector('#bulk-partner-select').value;
}

async function assignSelectedBills() {
  const billIds = [...selectedBillIds];
  const partnerId = document.querySelector('#bulk-partner-select').value;
  if (!billIds.length || !partnerId) return;

  const button = document.querySelector('#assign-selected-bills');
  button.disabled = true;
  button.textContent = 'Assigning...';
  try {
    const result = await requestJson('/api/bills/assignments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billIds, partnerId })
    });
    selectedBillIds.clear();
    document.querySelector('#select-visible-bills').checked = false;
    document.querySelector('#bulk-salesman-select').value = '';
    document.querySelector('#bulk-partner-select').value = '';
    await loadDeliveries();
    showToast(result.message);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.textContent = 'Assign bills';
    updateBulkAssignmentControls();
  }
}

async function saveAssignment(select) {
  select.disabled = true;
  try {
    await requestJson(`/api/bills/${encodeURIComponent(select.dataset.assignment)}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partnerId: select.value || null })
    });
    await loadDeliveries();
    showToast('Delivery assignment updated.');
  } catch (error) {
    showToast(error.message, true);
    await loadDeliveries();
  } finally {
    select.disabled = false;
  }
}

async function refreshDashboard() {
  if (document.hidden || uploadDialog.open || reconcileDialog.open) return;
  if (document.activeElement.matches('#search-input, #dashboard-date, [data-assignment]')) return;
  try {
    await loadDeliveries();
  } catch (error) {
    showToast(`Live refresh failed: ${error.message}`, true);
  }
}

async function signOut() {
  try {
    await requestJson('/api/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function exportSelectedDay() {
  if (!selectedDeliveryDate || !getSelectedDayDeliveries().length) return;

  exportButton.disabled = true;
  const label = exportButton.querySelector('span');
  label.textContent = 'Preparing...';

  try {
    const response = await fetch(`/api/bills/export?date=${encodeURIComponent(selectedDeliveryDate)}`);
    if (!response.ok) {
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`Could not download the Excel report (${response.status}).`);
      }
      throw new Error(body.error || `Could not download the Excel report (${response.status}).`);
    }

    const workbook = await response.blob();
    const url = URL.createObjectURL(workbook);
    const link = document.createElement('a');
    link.href = url;
    link.download = `TAF-Disti-Desk-${selectedDeliveryDate}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Downloaded the Excel delivery report for ${formatDate(selectedDeliveryDate)}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    label.textContent = 'Export Excel';
    exportButton.disabled = getSelectedDayDeliveries().length === 0;
  }
}

async function downloadExcelReport(endpoint, filename, button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing...';
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error(`Could not download the Excel report (${response.status}).`);
      }
      throw new Error(body.error || `Could not download the Excel report (${response.status}).`);
    }
    const workbook = await response.blob();
    const url = URL.createObjectURL(workbook);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Downloaded ${filename}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function openUploadDialog() {
  selectedFile = null;
  fileInput.value = '';
  document.querySelector('#import-date').value = selectedDeliveryDate;
  document.querySelector('#file-hint').textContent = 'Excel (.xlsx) or CSV · up to 10 MB';
  confirmUpload.disabled = true;
  uploadError.hidden = true;
  uploadError.textContent = '';
  uploadButtonLabel.textContent = 'Import file';
  uploadDialog.showModal();
}

function chooseFile(file) {
  if (!file) return;
  const allowed = /\.(xlsx|csv)$/i.test(file.name);
  if (!allowed) {
    uploadError.textContent = 'Choose an Excel (.xlsx) or CSV file.';
    uploadError.hidden = false;
    selectedFile = null;
    confirmUpload.disabled = true;
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    uploadError.textContent = 'This file is larger than 10 MB. Please choose a smaller file.';
    uploadError.hidden = false;
    selectedFile = null;
    confirmUpload.disabled = true;
    return;
  }

  selectedFile = file;
  uploadError.hidden = true;
  document.querySelector('#file-hint').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  confirmUpload.disabled = false;
}

async function uploadFile() {
  if (!selectedFile) return;
  const deliveryDate = document.querySelector('#import-date').value;
  if (!deliveryDate) {
    uploadError.textContent = 'Choose the sales date to import.';
    uploadError.hidden = false;
    return;
  }
  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('deliveryDate', deliveryDate);
  confirmUpload.disabled = true;
  document.querySelector('#cancel-upload').disabled = true;
  uploadButtonLabel.textContent = 'Importing...';
  uploadError.hidden = true;

  try {
    const result = await requestJson('/api/bills/upload', { method: 'POST', body: formData });
    await loadDeliveries();
    uploadDialog.close();
    const skippedNotes = [];
    if (result.duplicateBillsSkipped) {
      skippedNotes.push(`${result.duplicateBillsSkipped} already-imported ${result.duplicateBillsSkipped === 1 ? 'bill was' : 'bills were'} skipped.`);
    }
    if (result.salesReturnsSkipped) {
      skippedNotes.push(`${result.salesReturnsSkipped} sales-return lines skipped.`);
    }
    if (result.salesmanMappingsUpdated) {
      skippedNotes.push(`Updated salesman names on ${result.salesmanMappingsUpdated} already-imported bills without changing their delivery progress.`);
    }
    const duplicateUploadOnly = result.billsImported === 0 && result.duplicateBillsSkipped > 0;
    const importSummary = duplicateUploadOnly
      ? `All ${result.duplicateBillsSkipped} bills were already imported for ${formatDate(result.deliveryDate)}. No duplicate bills added.`
      : `Imported ${result.billsImported} ${result.billsImported === 1 ? 'bill' : 'bills'} (${result.rowsImported} item lines) for ${formatDate(result.deliveryDate)}.`;
    showToast([importSummary, ...skippedNotes].join(' '));
  } catch (error) {
    uploadError.textContent = error instanceof TypeError
      ? 'Could not reach the app server. Check that the app is running and try again. Your file was not uploaded.'
      : error.message;
    uploadError.hidden = false;
    showToast(uploadError.textContent, true);
  } finally {
    confirmUpload.disabled = !selectedFile;
    document.querySelector('#cancel-upload').disabled = false;
    uploadButtonLabel.textContent = 'Import file';
  }
}

function openReconcileDialog(bill) {
  activeBill = bill;
  document.querySelector('#reconcile-item-search').value = '';
  document.querySelector('#reconcile-subtitle').textContent = `Bill #${bill.bill_no} · ${bill.outlet_name}`;
  document.querySelector('#mark-not-supplied').hidden = currentUser?.role === 'manager';
  document.querySelector('#not-supplied-note').textContent = bill.status === 'Not supplied'
    ? `This bill is carried forward from ${formatDate(bill.not_supplied_from_date)} until its outstanding quantity is resolved.`
    : 'The remaining quantity will stay on the dashboard for this date and carry forward on later dates until supplied.';
  document.querySelector('#not-supplied-error').hidden = true;
  document.querySelector('#reconcile-items').innerHTML = bill.items.map(item => `
    <div class="reconcile-row" data-item-row="${item.id}">
      <span class="reconcile-item-name" title="${escapeHtml(item.item_name)}">${escapeHtml(item.item_name)}</span>
      <span class="reconcile-ordered">${Number(item.qty_ordered)}</span>
      <label><span class="visually-hidden">Delivered quantity for ${escapeHtml(item.item_name)}</span><input class="quantity-input" type="number" min="0" max="${Number(item.qty_ordered)}" step="1" name="delivered-${item.id}" value="${Number(item.qty_delivered)}" required></label>
      <label><span class="visually-hidden">Returned quantity for ${escapeHtml(item.item_name)}</span><input class="quantity-input" type="number" min="0" max="${Number(item.qty_ordered)}" step="1" name="returned-${item.id}" value="${Number(item.qty_returned)}" required></label>
      <label><span class="visually-hidden">Return type for ${escapeHtml(item.item_name)}</span><select class="return-type-select" name="return-type-${item.id}" aria-label="Return type for ${escapeHtml(item.item_name)}" ${Number(item.qty_returned) ? 'required' : 'disabled'}><option value="">Choose</option><option value="R" ${item.return_type === 'R' ? 'selected' : ''}>R</option><option value="DA" ${item.return_type === 'DA' ? 'selected' : ''}>DA</option><option value="DUE" ${item.return_type === 'DUE' ? 'selected' : ''}>DUE</option></select></label>
      <button class="item-delivered-action" type="button" data-fully-delivered="${item.id}" aria-label="Mark ${escapeHtml(item.item_name)} fully delivered" title="Set delivered quantity to the ordered quantity and clear any returns">Mark fully delivered</button>
    </div>
  `).join('');
  filterReconcileItems();
  document.querySelector('#reconcile-error').hidden = true;
  updateDeliveryShortcutStates();
  updateNotSuppliedAction();
  reconcileDialog.showModal();
}

function filterReconcileItems() {
  const query = document.querySelector('#reconcile-item-search').value.trim().toLocaleLowerCase();
  const rows = [...document.querySelectorAll('#reconcile-items [data-item-row]')];
  let visibleCount = 0;
  for (const row of rows) {
    const matches = row.querySelector('.reconcile-item-name').textContent.toLocaleLowerCase().includes(query);
    row.hidden = !matches;
    if (matches) visibleCount += 1;
  }
  document.querySelector('#reconcile-search-empty').hidden = visibleCount > 0 || rows.length === 0;
}

function updateNotSuppliedAction() {
  const button = document.querySelector('#mark-not-supplied');
  if (!activeBill || button.hidden) return;

  const hasUnsavedChanges = activeBill.items.some(item =>
    Number(reconcileForm.elements.namedItem(`delivered-${item.id}`).value) !== Number(item.qty_delivered) ||
    Number(reconcileForm.elements.namedItem(`returned-${item.id}`).value) !== Number(item.qty_returned) ||
    String(reconcileForm.elements.namedItem(`return-type-${item.id}`).value || '') !== String(item.return_type || '')
  );
  const remaining = activeBill.items.reduce((total, item) => {
    const delivered = Number(reconcileForm.elements.namedItem(`delivered-${item.id}`).value);
    const returned = Number(reconcileForm.elements.namedItem(`returned-${item.id}`).value);
    return total + Math.max(0, Number(item.qty_ordered) - delivered - returned);
  }, 0);
  button.disabled = remaining === 0 || hasUnsavedChanges;
  button.title = hasUnsavedChanges
    ? 'Save or discard your quantity edits before marking this bill not supplied.'
    : remaining === 0
      ? 'There is no outstanding quantity to carry forward.'
      : 'Keep this bill on the dashboard for subsequent dates until its remaining quantity is resolved.';
}

async function markBillNotSupplied() {
  if (!activeBill) return;
  const button = document.querySelector('#mark-not-supplied');
  button.disabled = true;
  document.querySelector('#not-supplied-error').hidden = true;
  try {
    const result = await requestJson('/api/bills/not-supplied', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billId: activeBill.id, deliveryDate: selectedDeliveryDate })
    });
    reconcileDialog.close();
    await loadDeliveries();
    showToast(result.message);
  } catch (error) {
    const errorElement = document.querySelector('#not-supplied-error');
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally {
    updateNotSuppliedAction();
  }
}

function updateDeliveryShortcutStates() {
  if (!activeBill) return;

  let fullyDeliveredCount = 0;
  for (const item of activeBill.items) {
    const row = document.querySelector(`[data-item-row="${item.id}"]`);
    const delivered = Number(reconcileForm.elements.namedItem(`delivered-${item.id}`).value);
    const returned = Number(reconcileForm.elements.namedItem(`returned-${item.id}`).value);
    const returnType = reconcileForm.elements.namedItem(`return-type-${item.id}`);
    returnType.disabled = returned === 0;
    if (returned === 0) returnType.value = '';
    const hasReturn = returned > 0;
    const fullyDelivered = delivered === Number(item.qty_ordered) && !hasReturn;
    const itemButton = row.querySelector('[data-fully-delivered]');
    itemButton.disabled = hasReturn;
    itemButton.title = hasReturn
      ? 'Clear the returned quantity before marking this item fully delivered.'
      : 'Set delivered quantity to the ordered quantity.';
    itemButton.classList.toggle('is-fully-delivered', fullyDelivered);
    itemButton.setAttribute('aria-pressed', String(fullyDelivered));
    if (fullyDelivered) fullyDeliveredCount += 1;
  }

  const billButton = document.querySelector('#fill-bill-delivered');
  const hasReturns = activeBill.items.some(item =>
    Number(reconcileForm.elements.namedItem(`returned-${item.id}`).value) > 0
  );
  const billFullyDelivered = !hasReturns && fullyDeliveredCount === activeBill.items.length;
  billButton.disabled = hasReturns;
  billButton.title = hasReturns
    ? 'Clear all returned quantities before marking the whole bill fully delivered.'
    : 'Mark every item as delivered.';
  billButton.classList.toggle('is-fully-delivered', billFullyDelivered);
  billButton.setAttribute('aria-pressed', String(billFullyDelivered));
}

function fillItemAsFullyDelivered(itemId) {
  if (!activeBill) return;
  const item = activeBill.items.find(deliveryItem => deliveryItem.id === Number(itemId));
  if (!item) return;

  const returnedInput = reconcileForm.elements.namedItem(`returned-${item.id}`);
  if (Number(returnedInput.value) > 0) return;
  const deliveredInput = reconcileForm.elements.namedItem(`delivered-${item.id}`);
  deliveredInput.value = String(Number(item.qty_ordered));
  document.querySelector('#reconcile-error').hidden = true;
  updateDeliveryShortcutStates();
}

function fillBillAsFullyDelivered() {
  if (!activeBill) return;
  if (activeBill.items.some(item =>
    Number(reconcileForm.elements.namedItem(`returned-${item.id}`).value) > 0
  )) return;
  for (const item of activeBill.items) {
    fillItemAsFullyDelivered(item.id);
  }
}

async function saveReconciliation(event) {
  event.preventDefault();
  if (!activeBill) return;

  const formData = new FormData(reconcileForm);
  const items = activeBill.items.map(item => ({
    id: item.id,
    qty_delivered: Number(formData.get(`delivered-${item.id}`)),
    qty_returned: Number(formData.get(`returned-${item.id}`)),
    return_type: String(formData.get(`return-type-${item.id}`) || '')
  }));
  const invalid = items.some((item, index) =>
    !Number.isSafeInteger(item.qty_delivered) ||
    !Number.isSafeInteger(item.qty_returned) ||
    item.qty_delivered < 0 ||
    item.qty_returned < 0 ||
    item.qty_delivered + item.qty_returned > Number(activeBill.items[index].qty_ordered) ||
    (item.qty_returned > 0 && !['R', 'DA', 'DUE'].includes(item.return_type)) ||
    (item.qty_returned === 0 && item.return_type !== '')
  );

  if (invalid) {
    const errorElement = document.querySelector('#reconcile-error');
    errorElement.textContent = 'Delivered and returned quantities cannot exceed the quantity ordered. Choose R, DA, or DUE for returned stock.';
    errorElement.hidden = false;
    return;
  }

  const saveButton = document.querySelector('#save-reconcile');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving...';

  try {
    await requestJson('/api/bills/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billId: activeBill.id, items })
    });
    await loadDeliveries();
    reconcileDialog.close();
    showToast(`Progress saved for bill #${activeBill.bill_no}.`);
  } catch (error) {
    const errorElement = document.querySelector('#reconcile-error');
    errorElement.textContent = error.message;
    errorElement.hidden = false;
    showToast(error.message, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save progress';
  }
}

async function loadDamageReports() {
  const reportList = document.querySelector('#damage-report-list');
  const reportDate = document.querySelector('#rt-damage-date').value || selectedDeliveryDate;
  document.querySelector('#damage-history-date').textContent = `· ${formatDate(reportDate)}`;
  try {
    const reports = await requestJson(`/api/rt-damage?date=${encodeURIComponent(reportDate)}`);
    if (!reports.length) {
      reportList.innerHTML = `<p class="damage-history-empty">No RT damage reports for ${escapeHtml(formatDate(reportDate))}.</p>`;
      return;
    }
    reportList.innerHTML = reports.map(report => {
      const approvalClass = `damage-approval-${String(report.approvalStatus).toLocaleLowerCase()}`;
      const editButton = report.canEdit
        ? `<button class="text-link" type="button" data-edit-damage="${Number(report.id)}">Edit</button>`
        : '';
      const reviewActions = currentUser?.role === 'manager' && report.approvalStatus === 'Pending'
        ? `<div class="damage-report-review"><label class="damage-entry-month-label">RT entered in <input class="damage-entry-month" type="month" required aria-label="Month this RT was entered" value="${escapeHtml(report.rtEntryMonth || '')}"></label><input class="damage-review-note" type="text" maxlength="500" aria-label="Optional review note for RT ${escapeHtml(report.rtNumber)}" placeholder="Optional review note"><button class="button button-primary" type="button" data-review-damage="${Number(report.id)}" data-decision="Approved">Approve</button><button class="button button-secondary" type="button" data-review-damage="${Number(report.id)}" data-decision="Rejected">Reject</button></div>`
        : '';
      const reopenAction = currentUser?.role === 'admin' && report.approvalStatus !== 'Pending'
        ? `<button class="text-link" type="button" data-reopen-damage="${Number(report.id)}">Reopen for correction</button>`
        : '';
      return `
        <article class="damage-report${report.hasPhoto ? '' : ' damage-report-no-photo'}">
          ${report.hasPhoto ? `<a class="damage-report-photo-link" href="/api/rt-damage/${Number(report.id)}/photo" target="_blank" rel="noopener">
            <img src="/api/rt-damage/${Number(report.id)}/photo" alt="Damaged stock for RT ${escapeHtml(report.rtNumber)}" loading="lazy">
          </a>` : ''}
          <span class="damage-report-details">
            <strong>RT ${escapeHtml(report.rtNumber)} · ${escapeHtml(report.outletName || 'Outlet not recorded')}</strong>
            <span>Agent: ${escapeHtml(report.agentName || 'Not recorded')} · Submitted by ${escapeHtml(report.submittedBy)} · ${escapeHtml(formatDate(report.createdAt))}</span>
            <span class="damage-approval-status ${approvalClass}">${escapeHtml(report.approvalStatus)}</span>
            ${report.rtEntryMonth ? `<span>RT entered in: ${escapeHtml(new Date(`${report.rtEntryMonth}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span>` : ''}
            ${report.reviewedBy ? `<span>${escapeHtml(report.approvalStatus)} by ${escapeHtml(report.reviewedBy)}${report.reviewNote ? ` · ${escapeHtml(report.reviewNote)}` : ''}</span>` : ''}
          </span>
          <span class="damage-report-actions">${editButton}${reopenAction}</span>
          ${reviewActions}
        </article>
      `;
    }).join('');
  } catch (error) {
    reportList.innerHTML = `<p class="damage-history-empty error">${escapeHtml(error.message)}</p>`;
  }
}

function openDamageDialog() {
  resetDamageForm();
  document.querySelector('#rt-damage-error').hidden = true;
  document.querySelector('#rt-damage-error').textContent = '';
  damageDialog.showModal();
  loadDamageReports();
}

function resetDamageForm() {
  editingDamageReportId = null;
  damageForm.reset();
  document.querySelector('#rt-damage-date').value = selectedDeliveryDate || getLocalDateValue();
  document.querySelector('#rt-agent-input').value = currentUser?.fullName || '';
  document.querySelector('#cancel-edit-rt-damage').hidden = true;
  document.querySelector('#save-rt-damage').textContent = 'Save report';
}

function editDamageReport(reportId) {
  const reportDate = document.querySelector('#rt-damage-date').value || selectedDeliveryDate;
  requestJson(`/api/rt-damage?date=${encodeURIComponent(reportDate)}`).then(reports => {
    const report = reports.find(item => Number(item.id) === Number(reportId));
    if (!report?.canEdit) {
      showToast('This report is no longer available for editing.', true);
      return;
    }
    editingDamageReportId = report.id;
    document.querySelector('#rt-outlet-input').value = report.outletName;
    document.querySelector('#rt-agent-input').value = report.agentName;
    document.querySelector('#rt-number-input').value = report.rtNumber;
    document.querySelector('#rt-damage-date').value = report.damageDate;
    document.querySelector('#cancel-edit-rt-damage').hidden = false;
    document.querySelector('#save-rt-damage').textContent = 'Save changes';
    document.querySelector('#rt-damage-error').hidden = true;
    document.querySelector('#rt-damage-error').textContent = '';
    damageDialog.scrollTo({ top: 0, behavior: 'smooth' });
  }).catch(error => showToast(error.message, true));
}

async function saveDamageReport(event) {
  event.preventDefault();
  const error = document.querySelector('#rt-damage-error');
  if (!damageForm.reportValidity()) return;

  const button = document.querySelector('#save-rt-damage');
  button.disabled = true;
  button.textContent = 'Saving...';
  error.hidden = true;
  try {
    const damageDate = document.querySelector('#rt-damage-date').value;
    const formData = new FormData(damageForm);
    const result = editingDamageReportId
      ? await requestJson(`/api/rt-damage/${editingDamageReportId}`, {
        method: 'PUT',
        body: formData
      })
      : await requestJson('/api/rt-damage', {
        method: 'POST',
        body: formData
      });
    const rtNumber = document.querySelector('#rt-number-input').value.trim();
    resetDamageForm();
    document.querySelector('#rt-damage-date').value = damageDate;
    await loadDamageReports();
    showToast(result.message || `Damage report saved for RT ${rtNumber}.`);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    showToast(requestError.message, true);
  } finally {
    button.disabled = false;
    button.textContent = editingDamageReportId ? 'Save changes' : 'Save report';
  }
}

function downloadTemplate() {
  const csv = [
    'Bill No,Outlet Name,Address,Item Name,Quantity,Salesman Name',
    'ITC-1001,Green Corner Store,12 Market Road Mumbai,Sunfeast Dark Fantasy,24,Amit Kumar',
    'ITC-1001,Green Corner Store,12 Market Road Mumbai,Aashirvaad Atta,10,Amit Kumar',
    'ITC-1002,Daily Needs Mart,45 Park Street Pune,Bingo Mad Angles,18,Rahul Sharma'
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'delivery-import-template.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document.querySelector('#open-upload').addEventListener('click', openUploadDialog);
document.querySelector('#empty-upload').addEventListener('click', openUploadDialog);
document.querySelector('#open-rt-damage').addEventListener('click', openDamageDialog);
document.querySelector('#cancel-rt-damage').addEventListener('click', () => damageDialog.close());
document.querySelector('#cancel-edit-rt-damage').addEventListener('click', () => {
  resetDamageForm();
});
document.querySelector('#refresh-damage-reports').addEventListener('click', loadDamageReports);
document.querySelector('#rt-damage-date').addEventListener('change', loadDamageReports);
document.querySelector('#export-rt-damage').addEventListener('click', event => {
  const damageDate = document.querySelector('#rt-damage-date').value;
  if (!damageDate) {
    document.querySelector('#rt-damage-date').reportValidity();
    return;
  }
  const date = encodeURIComponent(damageDate);
  downloadExcelReport(`/api/rt-damage/export?date=${date}`, `RT-Damage-${damageDate}.xlsx`, event.currentTarget);
});
damageForm.addEventListener('submit', saveDamageReport);
document.querySelector('#damage-report-list').addEventListener('click', async event => {
  const editButton = event.target.closest('[data-edit-damage]');
  if (editButton) {
    editDamageReport(editButton.dataset.editDamage);
    return;
  }
  const reviewButton = event.target.closest('[data-review-damage]');
  if (reviewButton) {
    const report = reviewButton.closest('.damage-report');
    const monthInput = report.querySelector('.damage-entry-month');
    if (reviewButton.dataset.decision === 'Approved' && !monthInput.value) {
      monthInput.reportValidity();
      return;
    }
    const reviewNote = report.querySelector('.damage-review-note').value.trim();
    const rtEntryMonth = monthInput.value;
    reviewButton.disabled = true;
    try {
      const result = await requestJson(`/api/rt-damage/${reviewButton.dataset.reviewDamage}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: reviewButton.dataset.decision, reviewNote, rtEntryMonth })
      });
      showToast(result.message);
      await loadDamageReports();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      reviewButton.disabled = false;
    }
    return;
  }
  const reopenButton = event.target.closest('[data-reopen-damage]');
  if (reopenButton) {
    reopenButton.disabled = true;
    try {
      const result = await requestJson(`/api/rt-damage/${reopenButton.dataset.reopenDamage}/reopen`, { method: 'POST' });
      showToast(result.message);
      await loadDamageReports();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      reopenButton.disabled = false;
    }
  }
});
damageDialog.addEventListener('close', () => {
  resetDamageForm();
});
document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', signOut));
document.querySelector('#cancel-upload').addEventListener('click', () => uploadDialog.close());
document.querySelector('#confirm-upload').addEventListener('click', uploadFile);
document.querySelector('#download-template').addEventListener('click', downloadTemplate);
document.querySelector('#modal-template').addEventListener('click', downloadTemplate);
document.querySelector('#search-input').addEventListener('input', renderRows);
document.querySelector('#status-filter').addEventListener('change', renderRows);
document.querySelector('#delivery-agent-filter').addEventListener('change', renderRows);
document.querySelector('#delivery-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-reconcile]');
  if (!button) return;
  const bill = deliveries.find(delivery => delivery.id === Number(button.dataset.reconcile));
  if (bill) openReconcileDialog(bill);
});
document.querySelector('#delivery-rows').addEventListener('change', event => {
  const select = event.target.closest('[data-assignment]');
  if (select) saveAssignment(select);
  const checkbox = event.target.closest('[data-select-bill]');
  if (checkbox) {
    const billId = Number(checkbox.dataset.selectBill);
    if (checkbox.checked) selectedBillIds.add(billId);
    else selectedBillIds.delete(billId);
    updateBulkAssignmentControls();
  }
});
document.querySelector('#select-visible-bills').addEventListener('change', event => {
  for (const bill of visibleDeliveries()) {
    if (event.currentTarget.checked) selectedBillIds.add(bill.id);
    else selectedBillIds.delete(bill.id);
  }
  renderRows();
});
document.querySelector('#bulk-partner-select').addEventListener('change', () => updateBulkAssignmentControls());
document.querySelector('#bulk-salesman-select').addEventListener('change', event => {
  selectedSalesmanFilter = event.currentTarget.value.trim();
  selectedBillIds.clear();
  document.querySelector('#select-visible-bills').checked = false;
  document.querySelector('#select-salesman-outlets').disabled = !selectedSalesmanFilter;
  renderRows();
});
document.querySelector('#select-salesman-outlets').addEventListener('click', selectSalesmanOutlets);
document.querySelector('#assign-selected-bills').addEventListener('click', assignSelectedBills);
document.querySelector('#cancel-reconcile').addEventListener('click', () => reconcileDialog.close());
document.querySelector('#fill-bill-delivered').addEventListener('click', fillBillAsFullyDelivered);
document.querySelector('#mark-not-supplied').addEventListener('click', markBillNotSupplied);
document.querySelector('#reconcile-items').addEventListener('click', event => {
  const button = event.target.closest('[data-fully-delivered]');
  if (button) fillItemAsFullyDelivered(button.dataset.fullyDelivered);
});
document.querySelector('#reconcile-item-search').addEventListener('input', filterReconcileItems);
reconcileForm.addEventListener('input', () => {
  updateDeliveryShortcutStates();
  updateNotSuppliedAction();
});
reconcileForm.addEventListener('change', () => {
  updateDeliveryShortcutStates();
  updateNotSuppliedAction();
});
reconcileForm.addEventListener('submit', saveReconciliation);
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => chooseFile(fileInput.files[0]));
dropzone.addEventListener('dragover', event => {
  event.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('drag-over');
  chooseFile(event.dataTransfer.files[0]);
});
document.querySelector('#search-input').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.currentTarget.value = '';
    renderRows();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.querySelector('#search-input').focus();
  }
});
document.querySelector('#dashboard-date').addEventListener('change', event => {
  if (!event.currentTarget.value) return;
  selectedDeliveryDate = event.currentTarget.value;
  localStorage.setItem('tafDistiDesk.selectedDeliveryDate', selectedDeliveryDate);
  document.querySelector('#status-filter').value = 'All';
  renderRows();
  if (damageDialog.open) loadDamageReports();
});
document.querySelectorAll('.side-nav .nav-link[href^="#"]').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    let page = link.id === 'at-stock-link' ? 'at-stock'
      : link.id === 'profitability-link' ? 'profitability' : 'deliveries';
    if (page === 'profitability' && !['admin', 'manager'].includes(currentUser?.role)) return;
    if (['at-stock', 'at-assignment', 'at-damages'].includes(page) && !['admin', 'manager'].includes(currentUser?.role)) return;
    showDashboardPage(page);
    if (page === 'profitability' && currentUser.role === 'admin') {
      showProfitabilityTab('sku');
      loadProfitabilityReport();
    }
    if (page === 'at-stock') loadAtStockReport();
    if (page === 'at-assignment') loadAtAssignmentReport();
    if (page === 'at-damages') loadAtDamages();
  });
});
document.querySelector('#import-profit-sales').addEventListener('click', () => {
  document.querySelector('#profit-sales-file').click();
});
document.querySelector('#profit-sales-file').addEventListener('change', event => {
  uploadProfitabilityFile(event.currentTarget.files[0]);
});
document.querySelector('#import-profit-costs').addEventListener('click', () => {
  document.querySelector('#profit-costs-file').click();
});
document.querySelector('#profit-costs-file').addEventListener('change', event => {
  uploadProfitabilityCostsFile(event.currentTarget.files[0]);
});
document.querySelector('#profit-date').addEventListener('change', () => {
  if (!document.querySelector('#profitability-at-stock-report').hidden) {
    loadAtStockReport();
  } else if (!document.querySelector('#profitability-at-assignment-report').hidden) {
    loadAtAssignmentReport();
  } else if (currentUser?.role === 'admin') {
    loadProfitabilityReport();
  }
});
document.querySelector('#profitability-sku-tab-button').addEventListener('click', () => showProfitabilityTab('sku'));
document.querySelector('#profitability-rfa-tab-button').addEventListener('click', () => showProfitabilityTab('rfa'));
document.querySelector('#rfa-from-date').addEventListener('change', loadRfaReport);
document.querySelector('#rfa-to-date').addEventListener('change', loadRfaReport);
document.querySelector('#export-profitability').addEventListener('click', () => {
  const selectedDate = document.querySelector('#profit-date').value;
  if (!selectedDate) {
    showToast('Choose a profitability report date before exporting.', true);
    return;
  }
  downloadExcelReport(
    `/api/profitability/report?date=${encodeURIComponent(selectedDate)}&format=xlsx`,
    `SKU-Profitability-${selectedDate}.xlsx`,
    document.querySelector('#export-profitability')
  );
});
document.querySelector('#export-rfa-report').addEventListener('click', () => {
  const fromDate = document.querySelector('#rfa-from-date').value;
  const toDate = document.querySelector('#rfa-to-date').value;
  if (!fromDate || !toDate || fromDate > toDate) {
    showToast('Choose a valid from and to date before exporting the RFA report.', true);
    return;
  }
  const query = new URLSearchParams({ fromDate, toDate, format: 'xlsx' });
  downloadExcelReport(
    `/api/profitability/rfa-report?${query}`,
    `Net-RFA-${fromDate}-to-${toDate}.xlsx`,
    document.querySelector('#export-rfa-report')
  );
});
exportButton.addEventListener('click', exportSelectedDay);
async function initializeDashboard() {
  await loadCurrentUser();
  await loadDeliveryPartners();
  await loadDeliveries();
  if (currentUser.role === 'admin') await loadProfitabilityReport();
  window.setInterval(refreshDashboard, 5000);
}

initializeDashboard().catch(error => {
  document.querySelector('#empty-title').textContent = 'Could not load deliveries';
  document.querySelector('#empty-copy').textContent = error.message;
  document.querySelector('#empty-upload').hidden = true;
  document.querySelector('#empty-state').hidden = false;
  document.querySelector('#table-footer-copy').textContent = 'Delivery data is unavailable';
  showToast(error.message, true);
});
