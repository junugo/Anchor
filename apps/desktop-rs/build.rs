fn main() {
    slint_build::compile("ui/app.slint").expect("slint compile");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("assets/app.rc", embed_resource::NONE);
    }
}
