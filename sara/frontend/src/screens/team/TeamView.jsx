import { useSaraState } from '../../state/saraState';

export default function TeamView() {
  const { status, error, model } = useSaraState();

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  const people = model.domains?.people;

  return (
    <section className="product" aria-label="Team">
      <header className="product__hero">
        <p className="product__eyebrow">Team</p>
        <h2 className="product__title">People board</h2>
        <p className="product__summary">{people?.summary}</p>
      </header>

      <div className="product__grid">
        <section className="product__section product__section--span-12">
          <p className="product__section-title">Direct reports</p>
          <div className="product__grid">
            {(people?.members || []).map((member) => (
              <article key={member.name} className="product__card product__section--span-4">
                <p className="product__card-title">{member.name}</p>
                <p className="product__card-detail">{member.role} · {member.metric}</p>
                <div className="product__meta">
                  <span className="product__pill">{member.status}</span>
                </div>
                {member.flag && <p className="product__card-detail">{member.flag}</p>}
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
