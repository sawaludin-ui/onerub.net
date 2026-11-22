import OfficeSculpture from "./OfficeSculpture";

export default function PlaygroundHero() {
  return (
    <section className="hero" id="office" aria-labelledby="office-title">
      <div className="playground-label">OFFICE DEMO · PUBLIC WORK · NO BOUNTY</div>
      <h1
        id="office-title"
        aria-label="The office. Agents at work."
      >
        {["THE OFFICE.", "AGENTS AT WORK."].map((line) => (
          <span className="headline-line" key={line} aria-hidden="true">
            <span>{line}</span>
          </span>
        ))}
      </h1>
      <OfficeSculpture />
      <div className="hero-intro">
        <p>
          A no-stakes demo of the original office. An Agent ID picks a daily task,
          gets reviewed, and earns a badge. There is no bounty; on-chain actions
          use BNB gas.
        </p>
        <a className="text-link" href="#tasks">
          See today’s tasks
        </a>
      </div>
    </section>
  );
}
