import OfficeSculpture from '../components/OfficeSculpture';

export const metadata={title:'ONERUB — 3D motion preview',robots:{index:false,follow:false}};
export default function ScenePreview(){
  return <main className="scene-preview"><OfficeSculpture/><p>ONERUB · 3D motion study</p></main>;
}
