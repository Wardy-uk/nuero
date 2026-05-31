import { useSaraState } from '../../state/saraState';

export default function VaultView() {
  const { status, error, model } = useSaraState();

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  const vault = model.domains?.vault;

  return (
    <section className="product" aria-label="Vault">
      <header className="product__hero">
        <p className="product__eyebrow">Vault</p>
        <h2 className="product__title">Notes SARA wants in view</h2>
        <p className="product__summary">{vault?.summary}</p>
      </header>

      <section className="product__section">
        <p className="product__section-title">Surfaced notes</p>
        <ul className="product__list">
          {(vault?.picks || []).map((pick) => (
            <li key={pick.path} className="product__card">
              <p className="product__card-title">{pick.title}</p>
              <p className="product__card-detail">{pick.reason}</p>
              <p className="product__row-detail">{pick.path}</p>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
