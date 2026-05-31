import { useSaraState } from '../../state/saraState';

export default function TodosView() {
  const { status, error, model, presentation } = useSaraState();

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  const todos = presentation.todos;

  return (
    <section className="product" aria-label="Todos">
      <header className="product__hero">
        <p className="product__eyebrow">Todos</p>
        <h2 className="product__title">Backlog in plain sight</h2>
        <p className="product__summary">Live tasks pulled through the shared state model. This screen still reads one source of truth, it just no longer invents the backlog.</p>
        <div className="product__meta">
          <span className="product__pill">{todos.source}</span>
        </div>
      </header>

      <section className="product__section product__section--span-12">
        <p className="product__section-title">Current list</p>
        <ul className="product__list">
          {todos.items.map((item) => (
            <li key={item.id} className="product__card">
              <p className="product__card-title">{item.title}</p>
              <div className="product__meta">
                <span className="product__pill">{item.state}</span>
                {item.dueDate && <span className="product__pill">{item.dueDate.slice(0, 10)}</span>}
                {item.source && <span className="product__pill">{item.source}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
