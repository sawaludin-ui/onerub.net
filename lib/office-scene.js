import {mountHexTowerScene} from './supplied-hex/hexTowerScene.js';
export async function createOfficeScene(container) {
  const controller=mountHexTowerScene(container,{playing:false,speedMultiplier:1,turntable:false});
  return {setPlaying:playing=>controller.updateSettings({playing}),dispose:()=>controller.dispose()};
}
