import Pix4D.Gst 1.0

Session {
    Project {
        path : "C:/Antigravity/GatheringScans/data/pix4d_smoke_test/smoke_twd97.p4m"
        create : true

        SetGcpCrs {
            settings.srsDefinition : 'COMPOUNDCRS["TWD97 / TM2 zone 121 + TWVD 2001 height",PROJCRS["TWD97 / TM2 zone 121",BASEGEOGCRS["TWD97",DATUM["Taiwan Datum 1997",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",3824]],CONVERSION["Taiwan 2-degree TM zone 121",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],PARAMETER["Longitude of natural origin",121,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],PARAMETER["Scale factor at natural origin",0.9999,SCALEUNIT["unity",1],ID["EPSG",8805]],PARAMETER["False easting",250000,LENGTHUNIT["metre",1],ID["EPSG",8806]],PARAMETER["False northing",0,LENGTHUNIT["metre",1],ID["EPSG",8807]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],USAGE[SCOPE["Engineering survey, topographic mapping."],AREA["Taiwan, Republic of China - between 120°E and 122°E, onshore and offshore - Taiwan Island."],BBOX[20.41,119.99,26.72,122.06]],ID["EPSG",3826]],VERTCRS["TWVD 2001 height",VDATUM["Taiwan Vertical Datum 2001"],CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["metre",1]],GEOIDMODEL["TWGEOID2018h"],ID["EPSG",8904]]]'
            inputs : [InputCameras{ },TiePointSet{ },RoiSet{ }]
            outputs : [InputCameras{ },TiePointSet{ },RoiSet{ }]
        }
        SaveProject { }
    }
    CloseSession { }
}
