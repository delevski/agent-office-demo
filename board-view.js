// Pure display selection. All data remains untouched; history is a reversible view.
export function boardView(columns, showHistory = false) {
  return {
    keys: showHistory ? ['done'] : ['todo', 'doing'],
    activeCount: columns.todo.length + columns.doing.length,
    historyCount: columns.done.length,
  };
}
