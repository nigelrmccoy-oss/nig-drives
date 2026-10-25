/**
 * v1.4.0 M0: the vehicle physics runs at a fixed 120 Hz, independent of the
 * render frame rate. Vehicle.update() feeds the frame dt into an accumulator and
 * runs whole steps; the mesh is drawn interpolated between the last two steps.
 */
export const PHYS_HZ = 120;
export const PHYS_DT = 1 / PHYS_HZ;
/** Spiral-of-death guard: at most this many steps per rendered frame. */
export const MAX_SUBSTEPS = 8;