/** English source strings for 'monitor' (keys are prefixed 'monitor.'). */
export const monitor = {
  'monitor.wait.none': 'No one waiting',
  'monitor.wait.ok': 'Under {seconds} s target',
  'monitor.wait.warning': 'Warning: waiting {seconds} s or more',
  'monitor.wait.critical': 'Critical: waiting {seconds} s or more',

  'monitor.def.queued':
    'Chats waiting for an agent: queued or currently offered, not yet accepted. Limited to your departments and chats without a department.',
  'monitor.def.oldestWait':
    'Time since the longest-waiting queued chat was requested. Warning at 60 s, critical at 180 s by default.',
  'monitor.def.active': 'Chats currently being served by an agent.',
  'monitor.def.agents':
    'Available = connected, status Online and below capacity (owned chats, collaborations and pending reserved offers across all departments count). Online = connected with status Online.',
  'monitor.def.offered':
    'Pending assigned or transfer offers that reserve agent capacity and have not expired.',
  'monitor.def.backlog':
    'Active chats whose latest public visitor message has no later human agent public reply. Automated messages and internal notes do not clear the backlog.',
  'monitor.def.csat':
    'Good ÷ (good + bad) latest ratings for chats requested since local midnight in the workspace timezone. Unrated chats are excluded.',

  'monitor.card.stale': 'Stale',
  'monitor.card.definition': 'Definition',
  'monitor.card.definitionOf': 'Definition of {label}',
  'monitor.card.asOf': 'as of <time>{time}</time>',

  'monitor.counters.queued': 'Queued chats',
  'monitor.counters.oldestWait': 'Oldest wait',
  'monitor.counters.active': 'Active chats',
  'monitor.counters.available': 'Available agents',
  'monitor.counters.offered': 'Offered reservations',
  'monitor.counters.backlog': 'Response backlog',
  'monitor.counters.csat': 'CSAT today',
  'monitor.counters.unitChats': '{count, plural, one {chat} other {chats}}',
  'monitor.counters.unitOffers': '{count, plural, one {offer} other {offers}}',
  'monitor.counters.unitAwaiting': '{count, plural, one {chat awaiting reply} other {chats awaiting reply}}',
  'monitor.counters.ofOnline': 'of {count} online',
  'monitor.counters.noneOnline': 'No agent is online',
  'monitor.counters.noRatings': 'No ratings yet today',
  'monitor.counters.csatSample': '{good} good ÷ {rated} rated (n {n})',

  'monitor.view.noAccessTitle': 'Monitoring is not available for your role',
  'monitor.view.noAccessBody': 'Supervisors and admins can watch live queues and agent load here.',
  'monitor.view.title': 'Monitor',
  'monitor.view.description':
    'Live queues, wait times and agent load for your departments. Updates arrive within seconds.',
  'monitor.view.allDepartments': 'All departments',
  'monitor.view.allMyDepartments': 'All my departments',
  'monitor.view.unavailable': 'Live monitoring is unavailable: {error}',

  'monitor.live.staleTitle': 'Showing stale data',
  'monitor.live.refreshNow': 'Refresh now',
  'monitor.live.silent': 'No update for more than {seconds} s.',
  'monitor.live.silentConn':
    'No update for more than {seconds} s: live connection is {conn, select, idle {idle} connecting {connecting} reconnecting {reconnecting} offline {offline} other {{conn}}}.',
  'monitor.live.serverStale': 'The server marked this snapshot as stale.',
  'monitor.live.serverStaleConn':
    'The server marked this snapshot as stale. Live connection is {conn, select, idle {idle} connecting {connecting} reconnecting {reconnecting} offline {offline} other {{conn}}}.',
  'monitor.live.figuresAsOf': 'Figures are as of {date} and may be out of date.',
  'monitor.live.refreshFailed': 'Last refresh failed: {error}',
  'monitor.live.live': 'Live',
  'monitor.live.asOf': 'As of <time>{time}</time> ({timezone})',
  'monitor.live.limited': '· limited to your departments',

  'monitor.announce.level':
    'Oldest wait is {level, select, critical {critical} other {warning}}: {duration}. {count} queued.',
  'monitor.announce.back': 'Oldest wait is back within target.',

  'monitor.departments.busy':
    '{count, plural, one {# department is busy} other {# departments are busy}}: chats waiting with no available agent or a long wait.',
  'monitor.departments.noneBusy': 'No department is busy right now.',
  'monitor.departments.emptyTitle': 'No departments in scope',
  'monitor.departments.emptyBody': 'You are not a member of any department that can be monitored.',
  'monitor.departments.caption': 'Load per department',
  'monitor.departments.noDepartment': 'No department',
  'monitor.col.queued': 'Queued',
  'monitor.col.oldestWait': 'Oldest wait',
  'monitor.col.active': 'Active',
  'monitor.col.offers': 'Offers',
  'monitor.col.backlog': 'Backlog',
  'monitor.col.availableOnline': 'Available / online',
  'monitor.col.load': 'Load',
  'monitor.col.collab': 'Collab.',
  'monitor.col.oldestUnanswered': 'Oldest unanswered',
  'monitor.departments.busyBadge': 'Busy',

  'monitor.agents.sortBy': ', sort by {label}',
  'monitor.agents.title': 'Agents',
  'monitor.agents.description':
    'Status, capacity in use (owned + collaborations + reserved offers) and the oldest visitor message still waiting for a reply.',
  'monitor.agents.emptyTitle': 'No agents in scope',
  'monitor.agents.emptyBody': 'No enabled agent can serve the selected departments.',
  'monitor.agents.caption':
    'Agent grid, sorted by {sort, select, load {load} backlog {response backlog} unanswered {oldest unanswered message} other {name}}',
  'monitor.agents.accepting': 'Accepting chats',
  'monitor.agents.atCapacity': 'At capacity',
  'monitor.agents.notAccepting': 'Not accepting',
  'monitor.agents.slots': '{used} / {capacity} slots',
  'monitor.agents.full': 'Full',

  'monitor.role.owner': 'Owner',
  'monitor.role.admin': 'Admin',
  'monitor.role.supervisor': 'Supervisor',
  'monitor.role.agent': 'Agent',
  'monitor.role.analyst': 'Analyst',
} satisfies Record<string, string>;
