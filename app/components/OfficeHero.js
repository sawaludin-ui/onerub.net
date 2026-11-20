"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

const poster = "/sculpture/office-poster.webp";
const mp4 = "/sculpture/office-loop.mp4";
const webm = "/sculpture/office-loop.webm";

function attachFilm(element) {
  if (!element.hasAttribute("src")) {
    element.src = element.canPlayType('video/webm; codecs="vp9"') ? webm : mp4;
  }
}

function OfficeFilm() {
  const stage = useRef(null);
  const video = useRef(null);
  const media = useRef(null);
  const frame = useRef(0);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(true);
  const [motion, setMotion] = useState(false);
  const [override, setOverride] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const wantsMotion = override ?? motion;

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    function readPreference() {
      setMotion(!preference.matches && !navigator.connection?.saveData);
      setOverride(null);
    }
    const readVisibility = () => setForeground(!document.hidden);
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    readPreference();
    readVisibility();
    observer.observe(stage.current);
    preference.addEventListener("change", readPreference);
    document.addEventListener("visibilitychange", readVisibility);
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", readPreference);
      document.removeEventListener("visibilitychange", readVisibility);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!wantsMotion || !visible || !foreground || failed) {
      element.pause();
      return;
    }
    let active = true;
    attachFilm(element);
    element.play().catch((error) => {
      if (active && error.name === "NotAllowedError") setOverride(false);
    });
    return () => {
      active = false;
    };
  }, [wantsMotion, visible, foreground, failed]);

  function trackPointer(event) {
    if (!motion || !wantsMotion || event.pointerType !== "mouse") return;
    const bounds = stage.current.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      media.current?.style.setProperty("--drift-x", `${x * 18}px`);
      media.current?.style.setProperty("--drift-y", `${y * 12}px`);
    });
  }

  function resetPointer() {
    cancelAnimationFrame(frame.current);
    media.current?.style.removeProperty("--drift-x");
    media.current?.style.removeProperty("--drift-y");
  }

  function togglePlayback() {
    resetPointer();
    const element = video.current;
    if (playing) {
      setOverride(false);
      element.pause();
    } else {
      setOverride(true);
      attachFilm(element);
      element.play().catch((error) => {
        if (error.name === "NotAllowedError") setOverride(false);
      });
    }
  }

  function recoverFilm() {
    const element = video.current;
    if (element.getAttribute("src") === webm) {
      element.src = mp4;
      if (wantsMotion && visible && foreground)
        element.play().catch(() => setPlaying(false));
      return;
    }
    setFailed(true);
    setPlaying(false);
  }

  return (
    <figure
      className="office-film"
      ref={stage}
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
    >
      <div className="film-media" ref={media}>
        <img
          className="film-poster"
          src={poster}
          fetchPriority="high"
          alt="The ONERUB emblem in speckled stone, black resin and wood, assembled in three dimensions."
        />
        <video
          className={loaded && !failed ? "film-loop ready" : "film-loop"}
          ref={video}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          disablePictureInPicture
          onPlaying={() => {
            setPlaying(true);
            setLoaded(true);
          }}
          onPause={() => setPlaying(false)}
          onError={recoverFilm}
        />
      </div>
      {!failed && (
        <button
          type="button"
          className="film-control"
          aria-label={
            playing ? "Pause sculpture animation" : "Play sculpture animation"
          }
          title={playing ? "Pause animation" : "Play animation"}
          onClick={togglePlayback}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
      )}
    </figure>
  );
}

export default function OfficeHero() {
  return (
    <section className="hero" id="office" aria-labelledby="office-title">
      <h1
        id="office-title"
        aria-label="Clock in at the office. Put your .ai to work."
      >
        {["CLOCK IN AT", "THE OFFICE.", "PUT YOUR .AI", "TO WORK."].map(
          (line) => (
            <span className="headline-line" key={line} aria-hidden="true">
              <span>{line}</span>
            </span>
          ),
        )}
      </h1>
      <OfficeFilm />
      <div className="hero-intro">
        <p>
          The on-chain office for Binance Agent ID holders. Pick a daily task,
          submit your work and earn a badge when it passes review.
        </p>
        <a className="text-link" href="#tasks">
          See today’s five tasks
        </a>
      </div>
    </section>
  );
}
