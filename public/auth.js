const form = document.querySelector('[data-auth-form]');
const message = document.querySelector('[data-auth-message]');

function showMessage(text, success = false) {
  message.textContent = text;
  message.classList.toggle('success', success);
  message.hidden = false;
}

async function readResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`The server returned an unreadable response (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status}).`);
  }

  return result;
}

if (form) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const submit = form.querySelector('[type="submit"]');
    const originalLabel = submit.dataset.originalLabel || submit.textContent.trim();
    submit.dataset.originalLabel = originalLabel;
    submit.disabled = true;
    submit.textContent = form.dataset.busyLabel || 'Please wait...';
    message.hidden = true;

    try {
      const response = await fetch(form.dataset.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      const result = await readResponse(response);
      if (form.dataset.action === 'create-user') {
        form.reset();
        showMessage(result.message, true);
        await loadUsers();
      } else {
        window.location.assign('/');
      }
    } catch (error) {
      showMessage(error.message);
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  });
}

async function loadUsers() {
  const list = document.querySelector('#user-list-body');
  if (!list) return;

  try {
    const [users, session] = await Promise.all([
      readResponse(await fetch('/api/users')),
      readResponse(await fetch('/api/auth/session'))
    ]);
    if (!users.length) {
      list.innerHTML = '<tr><td colspan="5" class="user-list-empty">No team members yet.</td></tr>';
      return;
    }

    list.innerHTML = users.map(user => `
      <tr>
        <td><div class="user-list-name"><strong>${escapeHtml(user.fullName)}</strong><span>${escapeHtml(user.userId)}</span></div></td>
        <td>${escapeHtml(user.position)}</td>
        <td>${escapeHtml(user.companyName)}</td>
        <td><span class="user-role">${escapeHtml(roleLabel(user.role))}</span></td>
        <td>${user.id === session.user.id
          ? '<span class="user-list-name">Current account</span>'
          : `<button class="user-remove" type="button" data-remove-user="${user.id}" data-user-name="${escapeHtml(user.fullName)}">Remove</button>`}</td>
      </tr>
    `).join('');
  } catch (error) {
    list.innerHTML = `<tr><td colspan="5" class="user-list-empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

function roleLabel(role) {
  return { admin: 'Admin', manager: 'Manager', delivery_partner: 'Delivery Partner' }[role] || role;
}

document.querySelector('#user-list-body')?.addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-user]');
  if (!button || !window.confirm(`Remove ${button.dataset.userName} from the app? Any bills assigned to them will become unassigned.`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(button.dataset.removeUser)}`, { method: 'DELETE' });
    const result = await readResponse(response);
    showMessage(result.message, true);
    await loadUsers();
  } catch (error) {
    showMessage(error.message);
    button.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

document.querySelectorAll('[data-logout]').forEach(button => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  });
});

loadUsers();
