// Shared tab strip for the admin sub-pages (Evals, Settings). Generic over the tab-id
// type T so each caller keeps its own union (EvalKind, SettingsTab, …) fully typed.
export function SubNav<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: [T, string][];
  active: T;
  onSelect: (t: T) => void;
}) {
  return (
    <div className="subnav">
      {tabs.map(([id, label]) => (
        <button key={id} className={active === id ? 'on' : ''} onClick={() => onSelect(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
