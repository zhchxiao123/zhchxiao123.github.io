---
title: 专题
icon: fas fa-layer-group
order: 2
---

这里汇总了所有的深度技术专题。每个专题都包含了完整的系列文档和源码深度分析。

<div class="projects-list mt-4">
  {% for project in site.data.projects %}
  <div class="project-card-full mb-4 p-4 border shadow-sm rounded-0" style="background: var(--card-bg);">
    <div class="row align-items-center">
      <div class="col-auto">
        <div class="project-icon-large d-flex align-items-center justify-content-center" 
             style="width: 64px; height: 64px; background: var(--sidebar-hover-bg); color: var(--link-color);">
          {% if project.icon contains '/' or project.icon contains '.' %}
            <img src="{{ project.icon | relative_url }}" alt="{{ project.name }} logo" style="width: 40px; height: 40px; object-fit: contain;">
          {% else %}
            <i class="fas {{ project.icon }} fa-2x"></i>
          {% endif %}
        </div>
      </div>
      <div class="col">
        <h3 class="h4 mb-1">{{ project.name }}</h3>
        <p class="text-muted mb-0 small">{{ project.description }}</p>
      </div>
      <div class="col-auto">
        <a href="{{ project.doc_url | relative_url }}" class="btn btn-outline-primary rounded-0 px-4">阅读专题</a>
      </div>
    </div>
  </div>
  {% endfor %}
</div>

<style>
  .project-card-full {
    transition: border-color 0.2s;
  }
  .project-card-full:hover {
    border-color: var(--link-color) !important;
  }
</style>
