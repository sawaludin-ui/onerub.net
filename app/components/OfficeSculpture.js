"use client";

import {useEffect,useRef,useState} from 'react';

export default function OfficeSculpture(){
  const stage=useRef(null),canvas=useRef(null),engine=useRef(null);
  const [visible,setVisible]=useState(false);
  const [foreground,setForeground]=useState(true);
  const [motion,setMotion]=useState(false);
  const [ready,setReady]=useState(false);
  const [failed,setFailed]=useState(false);
  const playing=ready&&motion&&visible&&foreground&&!failed;
  useEffect(()=>{
    const preference=matchMedia('(prefers-reduced-motion: reduce)');
    const read=()=>setMotion(!preference.matches&&!navigator.connection?.saveData);
    const visibility=()=>setForeground(!document.hidden);
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));
    read();visibility();observer.observe(stage.current);
    preference.addEventListener('change',read);
    document.addEventListener('visibilitychange',visibility);
    return()=>{observer.disconnect();preference.removeEventListener('change',read);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  // Initialize once. Hidden tabs and offscreen sections stop drawing, retaining pose.
  useEffect(()=>{
    let active=true;
    import('../../lib/office-scene').then(m=>m.createOfficeScene(canvas.current)).then(scene=>{
      if(!active){scene.dispose();return;}
      engine.current=scene;setReady(true);
    }).catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;engine.current?.dispose();engine.current=null;};
  },[]);
  useEffect(()=>{engine.current?.setPlaying(playing);},[playing]);
  return <figure className="office-film" ref={stage} aria-label="Animated 3D ONERUB office sculpture">
    <div className="film-media">
      {!ready&&<span className="sculpture-status" role="status">{failed?'3D preview unavailable. Please reload.':'Loading 3D sculpture…'}</span>}
      <div ref={canvas} className={ready&&!failed?'film-loop ready sculpture-canvas':'film-loop sculpture-canvas'} aria-label="3D sculpture. Drag to turn the view." onContextMenu={e=>e.preventDefault()}/>
    </div>
  </figure>;
}
