const uploadDialog = document.querySelector('#upload-dialog');
const reconcileDialog = document.querySelector('#reconcile-dialog');
const fileInput = document.querySelector('#file-input');
const dropzone = document.querySelector('#dropzone');
const confirmUpload = document.querySelector('#confirm-upload');
const uploadButtonLabel = document.querySelector('#upload-button-label');
const uploadError = document.querySelector('#upload-error');
const reconcileForm = document.querySelector('#reconcile-form');
const exportButton = document.querySelector('#export-day');
const toast = document.querySelector('#toast');

let deliveries = [];
let deliveryPartners = [];
let currentUser = null;
let selectedFile = null;
let activeBill = null;
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
  return deliveries.filter(bill => getBillDeliveryDate(bill) === selectedDeliveryDate);
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
  return getSelectedDayDeliveries().filter(bill => {
    const matchesStatus = status === 'All' || bill.status === status;
    const searchable = [bill.bill_no, bill.outlet_name, bill.address, ...bill.items.map(item => item.item_name)]
      .join(' ')
      .toLowerCase();
    return matchesStatus && (!query || searchable.includes(query));
  });
}

function renderRows() {
  const rows = document.querySelector('#delivery-rows');
  const emptyState = document.querySelector('#empty-state');
  const emptyTitle = document.querySelector('#empty-title');
  const emptyCopy = document.querySelector('#empty-copy');
  const filtered = visibleDeliveries();

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

    const assignmentCell = ['admin', 'manager'].includes(currentUser?.role)
      ? `<td><select class="assignment-select" data-assignment="${bill.id}" aria-label="Assign bill ${escapeHtml(bill.bill_no)}"><option value="">Unassigned</option>${deliveryPartners.map(partner => `<option value="${partner.id}" ${Number(bill.assigned_to) === partner.id ? 'selected' : ''}>${escapeHtml(partner.fullName)}</option>`).join('')}</select></td>`
      : '';
    const actionCell = currentUser?.role === 'manager'
      ? '<td><span class="assignment-note">Assign a partner</span></td>'
      : `<td><button class="row-action" type="button" data-reconcile="${bill.id}" aria-label="Update delivery ${escapeHtml(bill.bill_no)}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6.5 12.5 3.6 3.6 7.7-8.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/></svg>Update</button></td>`;
    return `<tr>
      <td><div class="bill-cell"><span class="bill-number">#${escapeHtml(bill.bill_no)}</span><span class="bill-date">${escapeHtml(formatDate(bill.delivery_date || bill.created_at))}</span></div></td>
      <td><div class="outlet-cell"><span class="outlet-name" title="${escapeHtml(bill.outlet_name)}">${escapeHtml(bill.outlet_name)}</span><span class="outlet-address" title="${escapeHtml(bill.address || 'No address listed')}">${escapeHtml(bill.address || 'No address listed')}</span></div></td>
      <td><div class="item-summary">${itemPreview}${moreItems}</div></td>
      <td class="progress-cell"><div class="progress-label"><span>${quantities.delivered.toLocaleString()} / ${quantities.total.toLocaleString()} delivered</span><strong>${percentage}%</strong></div><div class="progress-track" aria-label="${percentage}% resolved, ${escapeHtml(deliveryStatus)}"><div class="progress-bar" style="width:${percentage}%"></div></div><span class="progress-pending">${escapeHtml(deliveryStatus)}</span></td>
      <td><span class="status-pill ${statusClass(bill.status)}">${escapeHtml(bill.status)}</span></td>
      ${assignmentCell}${actionCell}
    </tr>`;
  }).join('');

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
      : 'Try another search or status filter.';
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(savedDate || '')) {
    selectedDeliveryDate = savedDate;
  } else {
    const today = getLocalDateValue();
    const availableDates = deliveries.map(getBillDeliveryDate).filter(Boolean).sort();
    selectedDeliveryDate = availableDates.filter(date => date <= today).pop() || today;
  }
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
  document.querySelector('#open-upload').hidden = user.role === 'delivery_partner';
  document.querySelector('#download-template').hidden = user.role === 'delivery_partner';
  document.querySelector('#modal-template').hidden = user.role === 'delivery_partner';
  exportButton.hidden = user.role === 'delivery_partner';
  document.querySelector('#assigned-header').hidden = !['admin', 'manager'].includes(user.role);
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
    ? 'Assign each bill to a delivery partner and monitor progress as it happens.'
    : user.role === 'delivery_partner'
      ? 'Update delivery progress for the bills assigned to you.'
      : 'Import your order sheet and keep every drop-off on track.';
  document.querySelector('#panel-subtitle').textContent = user.role === 'manager'
    ? 'Assign deliveries to a partner and monitor their progress.'
    : user.role === 'delivery_partner'
      ? 'Only deliveries assigned to your account are shown.'
      : 'View orders and update delivery progress for the selected day.';
  document.querySelector('#empty-upload').hidden = user.role === 'delivery_partner';
  renderRows();
}

async function loadDeliveryPartners() {
  if (!['admin', 'manager'].includes(currentUser?.role)) return;
  deliveryPartners = await requestJson('/api/delivery-partners');
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
    const duplicateUploadOnly = result.billsImported === 0 && result.duplicateBillsSkipped > 0;
    const importSummary = duplicateUploadOnly
      ? `All ${result.duplicateBillsSkipped} bills were already imported for ${formatDate(result.deliveryDate)}. No duplicate bills added.`
      : `Imported ${result.billsImported} ${result.billsImported === 1 ? 'bill' : 'bills'} (${result.rowsImported} item lines) for ${formatDate(result.deliveryDate)}.`;
    showToast([importSummary, ...skippedNotes].join(' '));
  } catch (error) {
    uploadError.textContent = error.message;
    uploadError.hidden = false;
    showToast(error.message, true);
  } finally {
    confirmUpload.disabled = !selectedFile;
    document.querySelector('#cancel-upload').disabled = false;
    uploadButtonLabel.textContent = 'Import file';
  }
}

function openReconcileDialog(bill) {
  activeBill = bill;
  document.querySelector('#reconcile-subtitle').textContent = `Bill #${bill.bill_no} · ${bill.outlet_name}`;
  document.querySelector('#reconcile-items').innerHTML = bill.items.map(item => `
    <div class="reconcile-row" data-item-row="${item.id}">
      <span class="reconcile-item-name" title="${escapeHtml(item.item_name)}">${escapeHtml(item.item_name)}</span>
      <span class="reconcile-ordered">${Number(item.qty_ordered)}</span>
      <label><span class="visually-hidden">Delivered quantity for ${escapeHtml(item.item_name)}</span><input class="quantity-input" type="number" min="0" max="${Number(item.qty_ordered)}" step="1" name="delivered-${item.id}" value="${Number(item.qty_delivered)}" required></label>
      <label><span class="visually-hidden">Returned quantity for ${escapeHtml(item.item_name)}</span><input class="quantity-input" type="number" min="0" max="${Number(item.qty_ordered)}" step="1" name="returned-${item.id}" value="${Number(item.qty_returned)}" required></label>
      <button class="item-delivered-action" type="button" data-fully-delivered="${item.id}" aria-label="Mark ${escapeHtml(item.item_name)} fully delivered" title="Set delivered quantity to the ordered quantity and clear any returns">Mark fully delivered</button>
    </div>
  `).join('');
  document.querySelector('#reconcile-error').hidden = true;
  updateDeliveryShortcutStates();
  reconcileDialog.showModal();
}

function updateDeliveryShortcutStates() {
  if (!activeBill) return;

  let fullyDeliveredCount = 0;
  for (const item of activeBill.items) {
    const row = document.querySelector(`[data-item-row="${item.id}"]`);
    const delivered = Number(reconcileForm.elements.namedItem(`delivered-${item.id}`).value);
    const returned = Number(reconcileForm.elements.namedItem(`returned-${item.id}`).value);
    const fullyDelivered = delivered === Number(item.qty_ordered) && returned === 0;
    const itemButton = row.querySelector('[data-fully-delivered]');
    itemButton.classList.toggle('is-fully-delivered', fullyDelivered);
    itemButton.setAttribute('aria-pressed', String(fullyDelivered));
    if (fullyDelivered) fullyDeliveredCount += 1;
  }

  const billButton = document.querySelector('#fill-bill-delivered');
  const billFullyDelivered = fullyDeliveredCount === activeBill.items.length;
  billButton.classList.toggle('is-fully-delivered', billFullyDelivered);
  billButton.setAttribute('aria-pressed', String(billFullyDelivered));
}

function fillItemAsFullyDelivered(itemId) {
  if (!activeBill) return;
  const item = activeBill.items.find(deliveryItem => deliveryItem.id === Number(itemId));
  if (!item) return;

  const deliveredInput = reconcileForm.elements.namedItem(`delivered-${item.id}`);
  const returnedInput = reconcileForm.elements.namedItem(`returned-${item.id}`);
  deliveredInput.value = String(Number(item.qty_ordered));
  returnedInput.value = '0';
  document.querySelector('#reconcile-error').hidden = true;
  updateDeliveryShortcutStates();
}

function fillBillAsFullyDelivered() {
  if (!activeBill) return;
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
    qty_returned: Number(formData.get(`returned-${item.id}`))
  }));
  const invalid = items.some((item, index) =>
    !Number.isSafeInteger(item.qty_delivered) ||
    !Number.isSafeInteger(item.qty_returned) ||
    item.qty_delivered < 0 ||
    item.qty_returned < 0 ||
    item.qty_delivered + item.qty_returned > Number(activeBill.items[index].qty_ordered)
  );

  if (invalid) {
    const errorElement = document.querySelector('#reconcile-error');
    errorElement.textContent = 'Delivered and returned quantities cannot exceed the quantity ordered.';
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

function downloadTemplate() {
  const csv = [
    'Bill No,Outlet Name,Address,Item Name,Quantity',
    'ITC-1001,Green Corner Store,12 Market Road Mumbai,Sunfeast Dark Fantasy,24',
    'ITC-1001,Green Corner Store,12 Market Road Mumbai,Aashirvaad Atta,10',
    'ITC-1002,Daily Needs Mart,45 Park Street Pune,Bingo Mad Angles,18'
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
document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', signOut));
document.querySelector('#cancel-upload').addEventListener('click', () => uploadDialog.close());
document.querySelector('#confirm-upload').addEventListener('click', uploadFile);
document.querySelector('#download-template').addEventListener('click', downloadTemplate);
document.querySelector('#modal-template').addEventListener('click', downloadTemplate);
document.querySelector('#search-input').addEventListener('input', renderRows);
document.querySelector('#status-filter').addEventListener('change', renderRows);
document.querySelector('#delivery-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-reconcile]');
  if (!button) return;
  const bill = deliveries.find(delivery => delivery.id === Number(button.dataset.reconcile));
  if (bill) openReconcileDialog(bill);
});
document.querySelector('#delivery-rows').addEventListener('change', event => {
  const select = event.target.closest('[data-assignment]');
  if (select) saveAssignment(select);
});
document.querySelector('#cancel-reconcile').addEventListener('click', () => reconcileDialog.close());
document.querySelector('#fill-bill-delivered').addEventListener('click', fillBillAsFullyDelivered);
document.querySelector('#reconcile-items').addEventListener('click', event => {
  const button = event.target.closest('[data-fully-delivered]');
  if (button) fillItemAsFullyDelivered(button.dataset.fullyDelivered);
});
reconcileForm.addEventListener('input', updateDeliveryShortcutStates);
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
});
exportButton.addEventListener('click', exportSelectedDay);
async function initializeDashboard() {
  await loadCurrentUser();
  await loadDeliveryPartners();
  await loadDeliveries();
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
