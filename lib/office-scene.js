import {mountHexTowerScene} from './supplied-hex/hexTowerScene.js';
export async function createOfficeScene(container) {
  const controller=mountHexTowerScene(container,{active:false,playing:false,speedMultiplier:1,turntable:false});
  return {setActive:active=>controller.updateSettings({active}),setPlaying:playing=>controller.updateSettings({playing}),dispose:()=>controller.dispose()};
}
