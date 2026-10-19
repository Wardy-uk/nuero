'use strict';

// The ONE ranked task list: what Focus, the phone's Tasks tab and the standup's
// list_tasks tool all read. It lived inline in GET /api/todos/focus until
// 16 Oct 2026, when the standup needed the same answer to "what are the top
// things" — a second copy is how the standup and the screen come to disagree
// about what comes first.

const vaultCache = require('./vault-cache');
const { rankTasks } = require('./task-scoring');
const todoIntelligence = require('./todo-intelligence');
const msLocal = require('./ms-task-local');

const FILTERS = ['overdue', 'today', 'all'];

/** Ranked open tasks for a filter ('overdue' | 'today' | 'all'), cached like Focus. */
function rankedTodos(filter = 'overdue') {
  const todayStr = new Date().toISOString().split('T')[0];

  // CACHED: scored tasks (only recomputed if vault files changed or date rolled)
  return vaultCache.getScoredTasks(filter, () => {
    const { active } = vaultCache.getTodos();

    let tasks = active.map((t, i) => ({
      id: i + 1,
      task_id: t.task_id || null,
      taskPriority: t.taskPriority || null,
      // Same field, second whitelist. Focus renders the same cards, so a
      // Jira-linked task silently loses the one thing that explains why its
      // checkbox refuses — the identical silent drop, one route along.
      jiraKey: t.jiraKey || null,
      text: t.text,
      priority: t.priority || 'normal',
      // Same field, THIRD whitelist. `toTodoShape` carries moscow and
      // estimateMinutes, /focus dropped both, and the phone's field editor
      // then seeded every row as "none" — showing a task ranked Should as
      // unranked, and an hour's estimate as absent. Editing against a
      // baseline the screen invented is worse than not offering the edit.
      //
      // ⚠ `moscowSet` IS HIS DECISION AND `moscow` IS NOT. decorateTask
      // overwrites `moscow` further down with classifyMoscow's reading, so
      // by the time this leaves the route the field says what the task READS
      // as, which for an unranked row is a value nobody chose. An editor
      // seeding from that shows the classifier's guess as his own call, and
      // the first Save writes the guess into the store as a decision. Same
      // split the framing lines already use: `meta.moscow` is "you rated
      // this a MUST", `moscow` is "reads as urgent".
      moscowSet: t.moscow || null,
      moscowProposed: Boolean(t.moscowProposed),
      estimateMinutes: t.estimateMinutes == null ? null : t.estimateMinutes,
      household: t.household === 1 || t.household === true ? 1 : 0,
      due_date: t.due_date || null,
      source: t.source || null,
      done: t.status === 'done' ? 1 : 0,
      ms_id: t.ms_id || null,
      msPlan: t.msPlan || null,
      msSource: t.msSource || null,
      recurrence: t.recurrence || null,
      vault_task: true,
      filePath: t.filePath || null,
      lineNumber: t.lineNumber != null ? t.lineNumber : null,
    }));

    // The second copy of the 90-day plan injection is gone too (#52) — this
    // one was on /focus, so the dead vault walk ran on the hottest path in
    // the app.

    // ⚠ Annotate BEFORE the filter, not after. The date filters below are the
    // one place a task can be excluded outright, so a row Nick has marked
    // "my part done" has to be knowable by then — annotating afterwards
    // leaves it ranked correctly and still sitting at the top of the Overdue
    // tab, which is the screen the whole point was to get it off.
    tasks = msLocal.annotate(tasks);

    // Apply filter
    if (filter === 'overdue') {
      tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] < todayStr && !t.done && !t.myPartDone);
    } else if (filter === 'today') {
      tasks = tasks.filter(t => t.due_date && t.due_date.split('T')[0] === todayStr && !t.done && !t.myPartDone);
    } else {
      // ⚠ Still in ALL, always. A card whose other half is outstanding has
      // not gone anywhere, and dropping it from every view would trade a
      // false "you are late" for a false "there is nothing there" — the
      // worse of the two, because the first is at least visible.
      tasks = tasks.filter(t => !t.done);
    }

    return rankTasks(tasks.map((task) => todoIntelligence.decorateTask(task, todayStr)), todayStr);
  });
}

module.exports = { rankedTodos, FILTERS };
