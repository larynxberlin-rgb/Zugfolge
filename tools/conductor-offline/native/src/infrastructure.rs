//! Reiner Speicheradapter der Original-InfraRelease. Keine Fahr- oder Dispositionsregel.
use zugfolge_sim::operational::*;
use zugfolge_determinism::StateHasher;

#[derive(Debug)]
pub struct MemoryInfrastructure { release:OperationalInfraRelease, identity:String }
impl MemoryInfrastructure {
    pub fn new(release:OperationalInfraRelease)->Result<Self,String> {
        release.validate().map_err(|_|"offline_infrastructure_invalid")?;
        let mut hash=StateHasher::new("operational-in-memory-infrastructure/v1");
        hash.bytes("release",&serde_json::to_vec(&release).map_err(|_|"offline_infrastructure_invalid")?);
        Ok(Self {release,identity:hash.finish().to_hex()})
    }
}
impl OperationalInfrastructure for MemoryInfrastructure {
    fn release_id(&self)->&str {&self.release.id}
    fn binding_identity(&self)->&str {&self.identity}
    fn validate_attachment(&self)->Result<(),OperationalError> {self.release.validate()}
    fn route_version(&self,id:&str)->Result<Option<RouteVersion>,OperationalError> {Ok(self.release.route_versions.get(id).cloned())}
    fn interlocking_route(&self,id:&str)->Result<Option<InterlockingRouteTemplate>,OperationalError> {Ok(self.release.interlocking_routes.get(id).cloned())}
    fn train_interlocking_route(&self,id:&str,at:RouteMillimetres)->Result<Option<InterlockingRouteTemplate>,OperationalError> {
        Ok(self.release.interlocking_routes.values().find(|route|route.movement_kind==MovementKind::Train&&route.route_template_id==id&&route.authority_start_route_mm==at).cloned())
    }
    fn shunting_interlocking_routes(&self,end:RouteMillimetres)->Result<Vec<InterlockingRouteTemplate>,OperationalError> {
        Ok(self.release.interlocking_routes.values().filter(|route|route.movement_kind==MovementKind::Shunting&&route.authority_end_route_mm>=end).cloned().collect())
    }
    fn platform_interval(&self,id:&str)->Result<Option<TrackInterval>,OperationalError> {Ok(self.release.platform_intervals.get(id).cloned())}
    fn edge_geometry(&self,id:&str)->Result<Option<Vec<EdgeGeometryPoint>>,OperationalError> {Ok(self.release.edge_geometries.get(id).cloned())}
    fn contains_disruption_target(&self,effect:&OperationalDisruption)->Result<bool,OperationalError> {
        Ok(match effect {
            OperationalDisruption::ResourceClosed {resource_id}|OperationalDisruption::TrackDetectionFailed {resource_id}=>self.release.block_resources.contains(resource_id),
            OperationalDisruption::SpeedRestriction {edge_id,maximum_speed_mmps}=>*maximum_speed_mmps>0&&self.release.directed_edges.contains_key(edge_id),
            OperationalDisruption::SignalFailed {signal_id}=>self.release.signals.contains(signal_id),
            OperationalDisruption::SwitchFailed {switch_id}=>self.release.switches.contains(switch_id),
            OperationalDisruption::VehicleRestricted {..}=>true,
        })
    }
}
