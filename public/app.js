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
const damagePhotoInput = document.querySelector('#rt-damage-photo');
const exportButton = document.querySelector('#export-day');
const toast = document.querySelector('#toast');

let deliveries = [];
let deliveryPartners = [];
let currentUser = null;
let selectedFile = null;
let activeBill = null;
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
  const dayDeliveries = getSelectedDayDeliveries();
  const count = { Pending: 0, 'In progress': 0, Completed: 0, Returned: 0 };
  dayDeliveries.forEach(bill => {
    count[bill.status] = (count[bill.status] || 0) + 1;
  });

  const pendingBills = dayDeliveries.filter(bill => getQuantities(bill).remaining > 0).length;
  const pendingUnits = dayDeliveries.reduce((sum, bill) => sum + getQuantities(bill).remaining, 0);
  exportButton.disabled = dayDeliveries.length === 0;
  exportButton.title = dayDeliveries.length
    ? `Download the ${formatDate(selectedDeliveryDate)} delivery report as an Excel workbook`
    : `No deliveries to export for ${formatDate(selectedDeliveryDate)}`;
  document.querySelector('#total-count').textContent = dayDeliveries.length.toLocaleString();
  document.querySelector('#pending-count').textContent = pendingBills.toLocaleString();
  document.querySelector('#pending-unit-copy').textContent = `${pendingUnits.toLocaleString()} ${pendingUnits === 1 ? 'unit' : 'units'} still to deliver`;
  document.querySelector('#progress-count').textContent = (count['In progress'] || 0).toLocaleString();
  document.querySelector('#completed-count').textContent = ((count.Completed || 0) + (count.Returned || 0)).toLocaleString();
  document.querySelector('#nav-count').textContent = dayDeliveries.length > 99 ? '99+' : String(dayDeliveries.length);
}

function visibleDeliveries() {
  const query = document.querySelector('#search-input').value.trim().toLowerCase();
  const status = document.querySelector('#status-filter').value;
  const deliveryAgent = document.querySelector('#delivery-agent-filter').value;
  return getSelectedDayDeliveries().filter(bill => {
    const matchesStatus = status === 'All' || bill.status === status;
    const matchesDeliveryAgent = !deliveryAgent ||
      (deliveryAgent === 'unassigned'
        ? !bill.assigned_to
        : String(bill.assigned_to || '') === deliveryAgent);
    const matchesSalesman = !selectedSalesmanFilter ||
      String(bill.salesman || '').trim().toLocaleLowerCase() === selectedSalesmanFilter.toLocaleLowerCase();
    const searchable = [bill.bill_no, bill.outlet_name, bill.address, bill.assigned_partner_name, ...bill.items.map(item => item.item_name)]
      .join(' ')
      .toLowerCase();
    return matchesDeliveryAgent && matchesSalesman && matchesStatus && (!query || searchable.includes(query));
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
  document.querySelector('#profitability-link').hidden = user.role !== 'admin';
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

function showProfitabilityTab(tab) {
  const showRfa = tab === 'rfa';
  document.querySelector('#profitability-sku-report').hidden = showRfa;
  document.querySelector('#profitability-rfa-report').hidden = !showRfa;
  document.querySelector('#profitability-sku-tab-button').classList.toggle('active', !showRfa);
  document.querySelector('#profitability-rfa-tab-button').classList.toggle('active', showRfa);
  document.querySelector('#profitability-sku-tab-button').setAttribute('aria-selected', String(!showRfa));
  document.querySelector('#profitability-rfa-tab-button').setAttribute('aria-selected', String(showRfa));
  if (showRfa) loadRfaReport();
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
    await loadProfitabilityReport();
    await loadRfaReport();
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
  const isProfitability = page === 'profitability' && currentUser?.role === 'admin';
  document.querySelector('#overview').hidden = isProfitability;
  document.querySelector('#profitability').hidden = !isProfitability;
  document.querySelector('.day-picker').hidden = isProfitability;
  exportButton.hidden = isProfitability || currentUser?.role === 'delivery_partner';
  document.querySelector('.breadcrumbs strong').textContent = isProfitability ? 'Profitability' : 'Deliveries';
  document.querySelectorAll('.side-nav .nav-link[href^="#"]').forEach(link => {
    const isActive = isProfitability
    ? link.id === 'profitability-link'
    : link.id === 'deliveries-link';
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
  document.querySelector('#reconcile-error').hidden = true;
  updateDeliveryShortcutStates();
  updateNotSuppliedAction();
  reconcileDialog.showModal();
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
  const dateField = document.querySelector('#rt-damage-date');
  if (dateField) dateField.value = selectedDeliveryDate;
  document.querySelector('#damage-history-date').textContent = `· ${formatDate(selectedDeliveryDate)}`;
  try {
    const reports = await requestJson(`/api/rt-damage?date=${encodeURIComponent(selectedDeliveryDate)}`);
    if (!reports.length) {
      reportList.innerHTML = `<p class="damage-history-empty">No RT damage reports for ${escapeHtml(formatDate(selectedDeliveryDate))}.</p>`;
      return;
    }
    reportList.innerHTML = reports.map(report => `
      <a class="damage-report" href="/api/rt-damage/${Number(report.id)}/photo" target="_blank" rel="noopener">
        <img src="/api/rt-damage/${Number(report.id)}/photo" alt="Damaged stock for RT ${escapeHtml(report.rtNumber)}" loading="lazy">
        <span class="damage-report-details">
          <strong>RT ${escapeHtml(report.rtNumber)}</strong>
          <span>${escapeHtml(report.submittedBy)} · ${escapeHtml(formatDate(report.createdAt))}</span>
        </span>
        <span class="damage-report-open" aria-hidden="true">↗</span>
      </a>
    `).join('');
  } catch (error) {
    reportList.innerHTML = `<p class="damage-history-empty error">${escapeHtml(error.message)}</p>`;
  }
}

function openDamageDialog() {
  document.querySelector('#rt-damage-error').hidden = true;
  document.querySelector('#rt-damage-error').textContent = '';
  document.querySelector('#rt-damage-date').value = selectedDeliveryDate;
  damageDialog.showModal();
  loadDamageReports();
}

function clearDamagePhoto() {
  const preview = document.querySelector('#damage-photo-preview');
  if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  preview.removeAttribute('src');
  document.querySelector('#damage-photo-name').textContent = '';
  document.querySelector('#damage-photo-preview-wrap').hidden = true;
  damagePhotoInput.value = '';
}

function previewDamagePhoto(file) {
  const error = document.querySelector('#rt-damage-error');
  error.hidden = true;
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    clearDamagePhoto();
    error.textContent = 'This photo is larger than 8 MB. Please choose a smaller photo.';
    error.hidden = false;
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    clearDamagePhoto();
    error.textContent = 'Choose a JPEG, PNG, or WebP photo.';
    error.hidden = false;
    return;
  }

  const preview = document.querySelector('#damage-photo-preview');
  if (preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(file);
  document.querySelector('#damage-photo-name').textContent = file.name;
  document.querySelector('#damage-photo-preview-wrap').hidden = false;
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
    const result = await requestJson('/api/rt-damage', {
      method: 'POST',
      body: new FormData(damageForm)
    });
    const rtNumber = document.querySelector('#rt-number-input').value.trim();
    damageForm.reset();
    clearDamagePhoto();
    await loadDamageReports();
    showToast(result.message || `Damage report saved for RT ${rtNumber}.`);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    showToast(requestError.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Save report';
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
document.querySelector('#refresh-damage-reports').addEventListener('click', loadDamageReports);
document.querySelector('#remove-damage-photo').addEventListener('click', clearDamagePhoto);
damagePhotoInput.addEventListener('change', () => previewDamagePhoto(damagePhotoInput.files[0]));
damageForm.addEventListener('submit', saveDamageReport);
damageDialog.addEventListener('close', () => {
  damageForm.reset();
  clearDamagePhoto();
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
    const page = link.id === 'profitability-link' ? 'profitability' : 'deliveries';
    if (page === 'profitability' && currentUser?.role !== 'admin') return;
    showDashboardPage(page);
    if (page === 'profitability') loadProfitabilityReport();
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
  loadProfitabilityReport();
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
