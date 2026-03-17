const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const db = require('../db/database');

const SCOPES = ['Tasks.Read', 'Tasks.Read.Shared', 'Calendars.Read', 'User.Read'];

let msalClient = null;
let tokenCache = null; // { accessToken, expiresOn, refreshToken, account }

function isConfigured() {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_TENANT_ID);
}

function getClient() {
  if (!msalClient && isConfigured()) {
    msalClient = new msal.PublicClientApplication({
      auth: {
        clientId: process.env.MS_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`
      }
    });
  }
  return msalClient;
}

function isAuthenticated() {
  const token = db.getState('ms_access_token');
  const expiresOn = db.getState('ms_token_expires');
  if (!token || !expiresOn) return false;
  // Consider authenticated if token exists (we'll refresh as needed)
  return true;
}

// Start device code flow — returns { userCode, verificationUri, message }
async function startDeviceCodeFlow() {
  const client = getClient();
  if (!client) throw new Error('Microsoft not configured');

  return new Promise((resolve, reject) => {
    client.acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        // Store the device code info so the frontend can show it
        db.setState('ms_auth_status', 'pending');
        db.setState('ms_device_code_message', response.message);
        db.setState('ms_device_code_uri', response.verificationUri);
        db.setState('ms_device_code_usercode', response.userCode);
        resolve({
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message
        });
      }
    }).then(result => {
      // Token acquired
      db.setState('ms_access_token', result.accessToken);
      db.setState('ms_token_expires', result.expiresOn.toISOString());
      db.setState('ms_account', JSON.stringify(result.account));
      db.setState('ms_auth_status', 'authenticated');
      db.setState('ms_device_code_message', '');
      tokenCache = {
        accessToken: result.accessToken,
        expiresOn: result.expiresOn,
        account: result.account
      };
      console.log('[Microsoft] Authenticated as', result.account.username);
    }).catch(err => {
      db.setState('ms_auth_status', 'error');
      db.setState('ms_auth_error', err.message);
      console.error('[Microsoft] Auth error:', err.message);
    });
  });
}

async function getAccessToken() {
  if (!isConfigured()) return null;

  const client = getClient();
  const accountStr = db.getState('ms_account');
  if (!accountStr) return null;

  const account = JSON.parse(accountStr);
  const cachedToken = db.getState('ms_access_token');
  const expiresStr = db.getState('ms_token_expires');

  // If token is still valid (with 5 min buffer), use it
  if (cachedToken && expiresStr) {
    const expiresOn = new Date(expiresStr);
    if (expiresOn > new Date(Date.now() + 5 * 60 * 1000)) {
      return cachedToken;
    }
  }

  // Try silent refresh
  try {
    const result = await client.acquireTokenSilent({
      scopes: SCOPES,
      account: account
    });
    db.setState('ms_access_token', result.accessToken);
    db.setState('ms_token_expires', result.expiresOn.toISOString());
    return result.accessToken;
  } catch (err) {
    console.error('[Microsoft] Silent refresh failed:', err.message);
    db.setState('ms_auth_status', 'expired');
    return null;
  }
}

async function graphFetch(path) {
  const token = await getAccessToken();
  if (!token) return null;

  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (res.status === 401) {
    db.setState('ms_auth_status', 'expired');
    return null;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body}`);
  }

  return res.json();
}

// Fetch all To Do tasks across all lists
async function fetchTodoTasks() {
  if (!isAuthenticated()) return [];

  try {
    // Get all task lists
    const listsData = await graphFetch('/me/todo/lists');
    if (!listsData) return [];

    const allTasks = [];
    for (const list of (listsData.value || [])) {
      const tasksData = await graphFetch(`/me/todo/lists/${list.id}/tasks?$filter=status ne 'completed'&$top=100`);
      if (!tasksData) continue;

      for (const task of (tasksData.value || [])) {
        allTasks.push({
          id: task.id,
          text: task.title,
          done: task.status === 'completed',
          priority: task.importance === 'high' ? 'high' : task.importance === 'low' ? 'low' : 'normal',
          due_date: task.dueDateTime ? task.dueDateTime.dateTime.split('T')[0] : null,
          source: `MS To Do: ${list.displayName}`,
          list_name: list.displayName,
          ms_id: task.id,
          ms_list_id: list.id,
          created_at: task.createdDateTime,
          is_overdue: task.dueDateTime ? new Date(task.dueDateTime.dateTime) < new Date() : false
        });
      }
    }
    return allTasks;
  } catch (err) {
    console.error('[Microsoft] Todo fetch error:', err.message);
    return [];
  }
}

// Fetch Planner tasks assigned to user
async function fetchPlannerTasks() {
  if (!isAuthenticated()) return [];

  try {
    const data = await graphFetch('/me/planner/tasks?$top=100');
    if (!data) return [];

    const tasks = [];
    for (const task of (data.value || [])) {
      if (task.percentComplete === 100) continue; // skip completed

      tasks.push({
        id: task.id,
        text: task.title,
        done: task.percentComplete === 100,
        priority: task.priority <= 3 ? 'high' : task.priority <= 5 ? 'normal' : 'low',
        due_date: task.dueDateTime ? task.dueDateTime.split('T')[0] : null,
        source: 'MS Planner',
        ms_id: task.id,
        created_at: task.createdDateTime,
        is_overdue: task.dueDateTime ? new Date(task.dueDateTime) < new Date() : false
      });
    }
    return tasks;
  } catch (err) {
    console.error('[Microsoft] Planner fetch error:', err.message);
    return [];
  }
}

// Fetch calendar events for a date range
async function fetchCalendarEvents(startDate, endDate) {
  if (!isAuthenticated()) return [];

  try {
    const start = startDate || new Date().toISOString();
    const end = endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const data = await graphFetch(
      `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=50&$orderby=start/dateTime&$select=subject,start,end,location,isAllDay,organizer,showAs`
    );
    if (!data) return [];

    return (data.value || []).map(event => ({
      id: event.id,
      subject: event.subject,
      start: event.start.dateTime,
      end: event.end.dateTime,
      timezone: event.start.timeZone,
      isAllDay: event.isAllDay,
      location: event.location ? event.location.displayName : null,
      organizer: event.organizer ? event.organizer.emailAddress.name : null,
      showAs: event.showAs
    }));
  } catch (err) {
    console.error('[Microsoft] Calendar fetch error:', err.message);
    return [];
  }
}

// Sync MS tasks into local todos table
async function syncTasksToLocal() {
  if (!isAuthenticated()) {
    console.log('[Microsoft] Not authenticated — skipping task sync');
    return;
  }

  try {
    console.log('[Microsoft] Syncing tasks...');
    const todoTasks = await fetchTodoTasks();
    const plannerTasks = await fetchPlannerTasks();
    const allTasks = [...todoTasks, ...plannerTasks];

    // Clear old MS-sourced todos and re-insert
    db.clearMsTodos();

    for (const task of allTasks) {
      db.createTodo(task.text, task.priority, task.due_date, task.source, task.ms_id);
    }

    db.setState('ms_last_sync', new Date().toISOString());
    db.setState('ms_task_count', String(allTasks.length));
    console.log(`[Microsoft] Synced ${allTasks.length} tasks (${todoTasks.length} To Do, ${plannerTasks.length} Planner)`);
  } catch (err) {
    console.error('[Microsoft] Sync error:', err.message);
  }
}

module.exports = {
  isConfigured,
  isAuthenticated,
  startDeviceCodeFlow,
  getAccessToken,
  fetchTodoTasks,
  fetchPlannerTasks,
  fetchCalendarEvents,
  syncTasksToLocal
};
