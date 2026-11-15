import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBounds, placeAnnotation } from '../src/AnnotationFloat';

test('annotationBounds intersects reader with zoomed visual viewport and keyboard inset', () => {
  assert.deepEqual(annotationBounds({ left: 600, top: 60, right: 1280, bottom: 900 }, { left: 500, top: 180, right: 1000, bottom: 620 }), { left: 608, top: 188, right: 992, bottom: 612 });
});
test('placeAnnotation flips beneath top-edge selection and clamps horizontal overflow', () => {
  const bounds = { left: 8, top: 70, right: 382, bottom: 830 };
  assert.deepEqual(placeAnnotation(bounds, { width: 300, height: 44 }, { left: 12, top: 76, right: 50, bottom: 98 }), { left: 8, top: 106 });
  assert.deepEqual(placeAnnotation(bounds, { width: 300, height: 44 }, { left: 360, top: 800, right: 380, bottom: 820 }), { left: 82, top: 748 });
});
test('placeAnnotation remains bounded when keyboard leaves less room than the editor', () => {
  assert.deepEqual(placeAnnotation({ left: 8, top: 160, right: 312, bottom: 360 }, { width: 340, height: 400 }, { left: 250, top: 300, right: 310, bottom: 330 }), { left: 8, top: 160 });
});
