void InputManager::RecreateRenderInputRouterSupport(
    const FrameSinkId& child_frame_sink_id,
    FrameSinkMetadata& frame_sink_metadata) {
  auto rir_map_it = rir_map_.find(child_frame_sink_id);
  CHECK(rir_map_it != rir_map_.end());
  input::RenderInputRouter* rir = rir_map_it->second.get();

  frame_sink_metadata.rir_support.reset();
  frame_sink_metadata.rir_support =
      MakeRenderInputRouterSupport(rir, child_frame_sink_id);
  frame_sink_metadata.rir_support->NotifySiteIsMobileOptimized(
      frame_sink_metadata.is_mobile_optimized);
}
