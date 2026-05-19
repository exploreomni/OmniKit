import type { CSSProperties } from 'react';

export type VehicleKind =
  | 'rocket'
  | 'jet'
  | 'fighter-jet'
  | 'airplane'
  | 'truck'
  | 'delivery-truck'
  | 'copier'
  | 'conveyor'
  | 'conveyor-belt'
  | 'bulldozer'
  | 'parachute'
  | 'f1'
  | 'sailboat'
  | 'detective';

interface VehicleProps {
  kind: VehicleKind;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  motion?: 'auto' | 'none';
}

const VEHICLE_SRC: Record<VehicleKind, string> = {
  rocket: '/blobby-vehicle-rocket.png',
  jet: '/blobby-vehicle-fighter-jet.png',
  'fighter-jet': '/blobby-vehicle-fighter-jet.png',
  airplane: '/blobby-vehicle-airplane.png',
  truck: '/blobby-vehicle-delivery-truck.png',
  'delivery-truck': '/blobby-vehicle-delivery-truck.png',
  copier: '/blobby-control-panel.png',
  conveyor: '/blobby-control-panel.png',
  'conveyor-belt': '/blobby-control-panel.png',
  bulldozer: '/blobby-vehicle-bulldozer.png',
  parachute: '/blobby-vehicle-parachute.png',
  f1: '/blobby-vehicle-racecar.png',
  sailboat: '/blobby-vehicle-sailboat.png',
  detective: '/blobby-vehicle-detective.png',
};

const VEHICLE_ALT: Record<VehicleKind, string> = {
  rocket: 'Blobby riding a rocket',
  jet: 'Blobby flying a fighter jet',
  'fighter-jet': 'Blobby flying a fighter jet',
  airplane: 'Blobby flying an airplane',
  truck: 'Blobby driving a delivery truck',
  'delivery-truck': 'Blobby driving a delivery truck',
  copier: 'Blobby operating a control panel',
  conveyor: 'Blobby operating a control panel',
  'conveyor-belt': 'Blobby operating a control panel',
  bulldozer: 'Blobby driving a bulldozer',
  parachute: 'Blobby descending with a parachute',
  f1: 'Blobby driving a race car',
  sailboat: 'Blobby sailing a boat',
  detective: 'Blobby looking for clues',
};

const VEHICLE_MOTION: Record<VehicleKind, string> = {
  rocket: 'animate-vehicle-flight',
  jet: 'animate-vehicle-flight',
  'fighter-jet': 'animate-vehicle-flight',
  airplane: 'animate-vehicle-flight',
  truck: 'animate-vehicle-drive',
  'delivery-truck': 'animate-vehicle-drive',
  copier: 'animate-vehicle-work',
  conveyor: 'animate-vehicle-work',
  'conveyor-belt': 'animate-vehicle-work',
  bulldozer: 'animate-vehicle-drive',
  parachute: 'animate-vehicle-parachute',
  f1: 'animate-vehicle-race',
  sailboat: 'animate-vehicle-sail',
  detective: 'animate-vehicle-inspect',
};

export function Vehicle({ kind, width = 92, height = 64, className = '', style, alt, motion = 'auto' }: VehicleProps) {
  const hasExplicitAnimation = /\banimate-/.test(className);
  const motionClass = motion === 'auto' && !hasExplicitAnimation ? VEHICLE_MOTION[kind] : '';

  return (
    <img
      src={VEHICLE_SRC[kind]}
      alt={alt ?? VEHICLE_ALT[kind]}
      width={width}
      height={height}
      className={`select-none pointer-events-none object-contain ${motionClass} ${className}`}
      style={{ width, height, ...style }}
      draggable={false}
    />
  );
}
