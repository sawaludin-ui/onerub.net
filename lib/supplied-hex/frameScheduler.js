// One pending frame/fence at most; suspension never leaves GPU syncs or timers alive.
export function createFrameScheduler({draw, software = false, gl, host = window, now = () => performance.now()}) {
  let active = true, disposed = false, drawing = false, pending = null, sync = null;
  function cancel() {
    if (pending !== null) {
      if (software) host.clearTimeout(pending);
      else host.cancelAnimationFrame(pending);
      pending = null;
    }
    if (sync !== null) { gl.deleteSync(sync); sync = null; }
  }
  function run() {
    pending = null;
    if (!active || disposed) return;
    drawing = true;
    let continuous;
    try { continuous = draw(now()); } finally { drawing = false; }
    if (continuous) request();
  }
  function request() {
    if (!active || disposed || drawing || pending !== null) return;
    if (!software) { pending = host.requestAnimationFrame(run); return; }
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) { pending = host.setTimeout(run, 80); return; }
    gl.flush();
    const poll = () => {
      pending = null;
      if (!active || disposed) return;
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.UNSIGNALED) {
        pending = host.setTimeout(poll, 5);
      } else {
        gl.deleteSync(sync); sync = null;
        pending = host.setTimeout(run, 80);
      }
    };
    pending = host.setTimeout(poll, 5);
  }
  return {
    request,
    setActive(value) { active = value; if (!active) cancel(); else request(); },
    dispose() { disposed = true; cancel(); },
  };
}
